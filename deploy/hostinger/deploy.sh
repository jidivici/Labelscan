#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_ROOT="/opt/labelscan"
readonly SOURCE_ROOT="${APP_ROOT}/source"
readonly COMPOSE_FILE="${APP_ROOT}/config/compose.yml"
readonly BACKUP_ROOT="${APP_ROOT}/backups"
readonly LOCK_FILE="/var/lock/labelscan-deploy.lock"
readonly HEALTH_URL="https://label-scan.fr/v1/health/ready"

die() {
  printf 'deploy error: %s\n' "$*" >&2
  exit 1
}

reset_demo=0
reset_started=0
case $# in
  2) ;;
  3)
    [[ "$3" == "--reset-demo" ]] || die "usage: $0 <checked-out-repository> <commit-sha> [--reset-demo]"
    reset_demo=1
    ;;
  *) die "usage: $0 <checked-out-repository> <commit-sha> [--reset-demo]" ;;
esac

checkout_root="$(realpath "$1")"
commit_sha="$2"

[[ "$commit_sha" =~ ^[0-9a-f]{40}$ ]] || die "commit SHA is invalid"
[[ -d "${checkout_root}/.git" || -f "${checkout_root}/.git" ]] || die "source is not a Git checkout"
[[ "$(git -C "$checkout_root" rev-parse HEAD)" == "$commit_sha" ]] || die "checkout does not match requested commit"
[[ -f "${checkout_root}/server/Dockerfile" ]] || die "server Dockerfile is missing"
[[ -f "${checkout_root}/web/package-lock.json" ]] || die "web lockfile is missing"
[[ -f "$COMPOSE_FILE" ]] || die "VPS Compose file is missing"

exec 9>"$LOCK_FILE"
flock -n 9 || die "another deployment is already running"

install -d -m 700 "$BACKUP_ROOT"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
short_sha="${commit_sha:0:12}"
backup_file="${BACKUP_ROOT}/${timestamp}-${short_sha}.dump"

printf '==> Backing up PostgreSQL to %s\n' "$backup_file"
docker compose -f "$COMPOSE_FILE" exec -T db \
  pg_dump -U labelscan_app -d labelscan -Fc >"$backup_file"
chmod 600 "$backup_file"

reset_demo_data() {
  reset_started=1
  printf '==> Resetting production data to the demo seed\n'
  printf '==> Stopping API and workers before replacing the database\n'
  docker compose -f "$COMPOSE_FILE" stop api worker

  # The raw object volume is application data too. Limit deletion to the
  # LabelScan mount; never remove Compose, proxy, database, or TLS volumes.
  printf '==> Removing existing raw LabelScan objects\n'
  docker compose -f "$COMPOSE_FILE" run --rm --no-deps \
    --entrypoint /bin/sh api -c 'find /app/data/raw -depth -mindepth 1 -delete'

  # Stop all client connections, then keep DROP and CREATE as individual
  # statements — PostgreSQL forbids DROP DATABASE inside a transaction.
  printf '==> Recreating the LabelScan database\n'
  docker compose -f "$COMPOSE_FILE" exec -T db \
    psql -U labelscan_app -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'labelscan' AND pid <> pg_backend_pid();"
  docker compose -f "$COMPOSE_FILE" exec -T db \
    psql -U labelscan_app -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE labelscan;'
  docker compose -f "$COMPOSE_FILE" exec -T db \
    psql -U labelscan_app -d postgres -v ON_ERROR_STOP=1 \
    -c 'CREATE DATABASE labelscan OWNER labelscan_app;'
  docker compose -f "$COMPOSE_FILE" run --rm --no-deps migrate
  docker compose -f "$COMPOSE_FILE" run --rm --no-deps demo
}

printf '==> Synchronizing deployable source for %s\n' "$commit_sha"
install -d -m 700 "$SOURCE_ROOT"
rsync -a --delete \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'test-results/' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  "${checkout_root}/.dockerignore" \
  "${checkout_root}/server" \
  "${checkout_root}/web" \
  "${SOURCE_ROOT}/"

if docker image inspect labelscan-local:current >/dev/null 2>&1; then
  printf '==> Preserving the current application image\n'
  docker tag labelscan-local:current labelscan-local:previous
fi

rollback_image() {
  exit_code=$?
  if [[ "$reset_started" -eq 1 ]]; then
    # A reset replaces both PostgreSQL and raw data. Reverting only the image
    # would combine old code with a new schema/data set; the VPS snapshot is
    # the coherent recovery point for this exceptional operation.
    printf '==> Reset deployment failed; use the VPS snapshot to recover a coherent pre-reset state\n' >&2
    exit "$exit_code"
  fi
  if docker image inspect labelscan-local:previous >/dev/null 2>&1; then
    printf '==> Deployment failed; restoring the previous application image\n' >&2
    docker tag labelscan-local:previous labelscan-local:current
    docker compose -f "$COMPOSE_FILE" up -d --no-deps --scale worker=2 api worker caddy || true
  fi
  exit "$exit_code"
}
trap rollback_image ERR

printf '==> Building the private image on the VPS\n'
docker compose -f "$COMPOSE_FILE" build migrate

if [[ "$reset_demo" -eq 1 ]]; then
  reset_demo_data
fi

printf '==> Applying database migrations\n'
docker compose -f "$COMPOSE_FILE" run --rm migrate

printf '==> Recreating API and workers without running demo seed data\n'
docker compose -f "$COMPOSE_FILE" up -d --no-deps --scale worker=2 api worker caddy

printf '==> Waiting for the public readiness endpoint\n'
ready=0
for attempt in $(seq 1 30); do
  if response="$(curl --fail --silent --show-error --max-time 10 "$HEALTH_URL")" \
    && [[ "$response" == *'"status":"ready"'* ]]; then
    ready=1
    break
  fi
  sleep 5
done
[[ "$ready" -eq 1 ]] || die "readiness endpoint did not become healthy"

trap - ERR

printf '%s %s\n' "$timestamp" "$commit_sha" >"${APP_ROOT}/DEPLOYED_VERSION"
chmod 600 "${APP_ROOT}/DEPLOYED_VERSION"

# Keep the fourteen most recent database backups. Paths are tightly scoped to
# LabelScan's private backup directory.
find "$BACKUP_ROOT" -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' \
  | sort -rn \
  | tail -n +15 \
  | cut -d' ' -f2- \
  | xargs -r rm --

docker compose -f "$COMPOSE_FILE" ps
printf '==> Deployment %s is healthy\n' "$short_sha"
