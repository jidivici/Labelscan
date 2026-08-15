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

[[ $# -eq 2 ]] || die "usage: $0 <checked-out-repository> <commit-sha>"

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
