#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_ROOT="/opt/labelscan"
readonly SOURCE_ROOT="${APP_ROOT}/source"
readonly COMPOSE_FILE="${APP_ROOT}/config/compose.yml"
readonly REPOSITORY_COMPOSE="deploy/compose/single-vps.yml"
readonly BACKUP_ROOT="${APP_ROOT}/backups"
readonly SECRETS_ROOT="${APP_ROOT}/secrets"
readonly DB_ROLE_MARKER="${APP_ROOT}/.database-roles-v4"
readonly DEMO_CREDENTIALS_MARKER="${APP_ROOT}/.demo-credentials-secured"
readonly JWT_ROTATION_MARKER="${APP_ROOT}/.jwt-secret-v2"
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
[[ -f "${checkout_root}/${REPOSITORY_COMPOSE}" ]] || die "single-VPS Compose file is missing"
[[ -f "$COMPOSE_FILE" ]] || die "VPS Compose file is missing"

export LABELSCAN_VERSION="$commit_sha"

exec 9>"$LOCK_FILE"
flock -n 9 || die "another deployment is already running"

install -d -m 700 "$BACKUP_ROOT"
install -d -m 700 "$SECRETS_ROOT"

install_secret() {
  local target="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp "${target}.tmp.XXXXXX")"
  chmod 600 "$temporary"
  printf '%s' "$value" >"$temporary"
  chown root:root "$temporary"
  mv -f "$temporary" "$target"
}

extract_legacy_secret() {
  local name="$1"
  local target="$2"
  local legacy_file value
  [[ -s "$target" ]] && return
  legacy_file="${SECRETS_ROOT}/app.env"
  [[ -r "$legacy_file" ]] || die "${target} is missing and no legacy app.env can migrate it"
  value="$(sed -n "s/^${name}=//p" "$legacy_file" | tail -n 1)"
  value="${value%$'\r'}"
  [[ -n "$value" ]] || die "${name} is missing from the legacy app.env"
  install_secret "$target" "$value"
}

ensure_provider_secrets() {
  extract_legacy_secret LABELSCAN_GOOGLE_VISION_API_KEY "${SECRETS_ROOT}/google_vision_api_key"
  extract_legacy_secret ANTHROPIC_API_KEY "${SECRETS_ROOT}/anthropic_api_key"
}

ensure_demo_credentials() {
  local target="${SECRETS_ROOT}/demo_credentials.json"
  local super_admin_password admin_password manager_f_password
  local manager_n_password manager_c_password manager_m_password value
  [[ -s "$target" ]] && return
  umask 077
  super_admin_password="$(openssl rand -hex 24)"
  admin_password="$(openssl rand -hex 24)"
  manager_f_password="$(openssl rand -hex 24)"
  manager_n_password="$(openssl rand -hex 24)"
  manager_c_password="$(openssl rand -hex 24)"
  manager_m_password="$(openssl rand -hex 24)"
  value="$(printf '{\n  "super_admin": "%s",\n  "admin": "%s",\n  "manager_p_f": "%s",\n  "manager_p_n": "%s",\n  "manager_p_c": "%s",\n  "manager_p_m": "%s"\n}\n' \
    "$super_admin_password" "$admin_password" "$manager_f_password" \
    "$manager_n_password" "$manager_c_password" "$manager_m_password")"
  install_secret "$target" "$value"
}

rotate_jwt_once() {
  [[ -f "$JWT_ROTATION_MARKER" ]] && return
  install_secret "${SECRETS_ROOT}/jwt_secret" "$(openssl rand -hex 48)"
  install -m 600 /dev/null "$JWT_ROTATION_MARKER"
}

prepare_database_roles() {
  local required admin_password runtime_password sql_file admin_exists bootstrap_user bootstrap_is_runtime swap_user
  if [[ -f "$DB_ROLE_MARKER" ]]; then
    for required in db_admin_password db_runtime_password database_admin_url database_url; do
      [[ -s "${SECRETS_ROOT}/${required}" ]] || die "database role marker exists but ${required} is missing"
    done
    return
  fi

  admin_password="$(openssl rand -hex 48)"
  runtime_password="$(openssl rand -hex 48)"

  admin_exists="$(docker compose -f "$COMPOSE_FILE" exec -T db sh -c \
    'psql -U "$POSTGRES_USER" -d labelscan -Atc "SELECT count(*) FROM pg_roles WHERE rolname = '\''labelscan_db_admin'\''"')"
  bootstrap_is_runtime="$(docker compose -f "$COMPOSE_FILE" exec -T db sh -c \
    'psql -U "$POSTGRES_USER" -d labelscan -Atc "SELECT CASE WHEN oid = 10 THEN 1 ELSE 0 END FROM pg_roles WHERE rolname = '\''labelscan_app'\''"')"

  if [[ "$bootstrap_is_runtime" == "1" ]]; then
    if [[ "$admin_exists" == "1" ]]; then
      docker compose -f "$COMPOSE_FILE" exec -T db \
        psql -U labelscan_app -d labelscan -v ON_ERROR_STOP=1 \
        -c 'REVOKE labelscan_db_admin FROM labelscan_app;' \
        -c 'ALTER ROLE labelscan_db_admin RENAME TO labelscan_db_admin_retired_v2;'
      swap_user=labelscan_db_admin_retired_v2
    else
      docker compose -f "$COMPOSE_FILE" exec -T db \
        psql -U labelscan_app -d labelscan -v ON_ERROR_STOP=1 \
        -c 'CREATE ROLE labelscan_db_admin_swap LOGIN SUPERUSER CREATEDB CREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;'
      swap_user=labelscan_db_admin_swap
    fi
    docker compose -f "$COMPOSE_FILE" exec -T db \
      psql -U "$swap_user" -d labelscan -v ON_ERROR_STOP=1 \
      -c 'ALTER ROLE labelscan_app RENAME TO labelscan_db_admin;'
    if [[ "$swap_user" == "labelscan_db_admin_retired_v2" ]]; then
      docker compose -f "$COMPOSE_FILE" exec -T db \
        psql -U labelscan_db_admin -d labelscan -v ON_ERROR_STOP=1 \
        -c 'ALTER ROLE labelscan_db_admin_retired_v2 WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;'
    else
      docker compose -f "$COMPOSE_FILE" exec -T db \
        psql -U labelscan_db_admin -d labelscan -v ON_ERROR_STOP=1 \
        -c 'DROP ROLE labelscan_db_admin_swap;'
    fi
    bootstrap_user=labelscan_db_admin
  elif [[ "$admin_exists" == "1" ]]; then
    bootstrap_user=labelscan_db_admin
  else
    bootstrap_user="$(docker compose -f "$COMPOSE_FILE" exec -T db sh -c 'printf %s "$POSTGRES_USER"')"
  fi

  sql_file="$(mktemp "${BACKUP_ROOT}/.database-bootstrap.XXXXXX.sql")"
  chmod 600 "$sql_file"
  printf '%s\n' \
    'BEGIN;' \
    "DO \$bootstrap\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelscan_db_admin') THEN CREATE ROLE labelscan_db_admin LOGIN SUPERUSER CREATEDB CREATEROLE INHERIT NOREPLICATION BYPASSRLS PASSWORD '${admin_password}'; END IF; END \$bootstrap\$;" \
    "DO \$bootstrap\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelscan_app') THEN CREATE ROLE labelscan_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${runtime_password}'; END IF; END \$bootstrap\$;" \
    "ALTER ROLE labelscan_db_admin WITH LOGIN SUPERUSER CREATEDB CREATEROLE INHERIT NOREPLICATION BYPASSRLS PASSWORD '${admin_password}';" \
    'REVOKE labelscan_db_admin FROM labelscan_app;' \
    "DO \$bootstrap\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelscan_db_admin_retired_v2') THEN EXECUTE 'REVOKE labelscan_db_admin_retired_v2 FROM labelscan_app'; END IF; END \$bootstrap\$;" \
    "SELECT format('REVOKE %I FROM labelscan_app;', granted_role.rolname) FROM pg_auth_members membership JOIN pg_roles granted_role ON granted_role.oid = membership.roleid JOIN pg_roles member_role ON member_role.oid = membership.member WHERE member_role.rolname = 'labelscan_app';" \
    '\gexec' \
    'ALTER DATABASE labelscan OWNER TO labelscan_db_admin;' \
    "SELECT format('ALTER TABLE %I.%I OWNER TO labelscan_db_admin;', namespace.nspname, object.relname) FROM pg_class object JOIN pg_namespace namespace ON namespace.oid = object.relnamespace JOIN pg_roles owner ON owner.oid = object.relowner WHERE namespace.nspname IN ('ingestion', 'compliance', 'traceability', 'haccp', 'audit', 'identity', 'platform', 'public') AND owner.rolname IN ('labelscan_app', 'labelscan_db_admin_retired_v2') AND object.relkind IN ('r', 'p');" \
    '\gexec' \
    "SELECT format('ALTER VIEW %I.%I OWNER TO labelscan_db_admin;', namespace.nspname, object.relname) FROM pg_class object JOIN pg_namespace namespace ON namespace.oid = object.relnamespace JOIN pg_roles owner ON owner.oid = object.relowner WHERE namespace.nspname IN ('ingestion', 'compliance', 'traceability', 'haccp', 'audit', 'identity', 'platform', 'public') AND owner.rolname IN ('labelscan_app', 'labelscan_db_admin_retired_v2') AND object.relkind = 'v';" \
    '\gexec' \
    "SELECT format('ALTER MATERIALIZED VIEW %I.%I OWNER TO labelscan_db_admin;', namespace.nspname, object.relname) FROM pg_class object JOIN pg_namespace namespace ON namespace.oid = object.relnamespace JOIN pg_roles owner ON owner.oid = object.relowner WHERE namespace.nspname IN ('ingestion', 'compliance', 'traceability', 'haccp', 'audit', 'identity', 'platform', 'public') AND owner.rolname IN ('labelscan_app', 'labelscan_db_admin_retired_v2') AND object.relkind = 'm';" \
    '\gexec' \
    "SELECT format('ALTER SEQUENCE %I.%I OWNER TO labelscan_db_admin;', namespace.nspname, object.relname) FROM pg_class object JOIN pg_namespace namespace ON namespace.oid = object.relnamespace JOIN pg_roles owner ON owner.oid = object.relowner WHERE namespace.nspname IN ('ingestion', 'compliance', 'traceability', 'haccp', 'audit', 'identity', 'platform', 'public') AND owner.rolname IN ('labelscan_app', 'labelscan_db_admin_retired_v2') AND object.relkind = 'S';" \
    '\gexec' \
    "SELECT format('ALTER FOREIGN TABLE %I.%I OWNER TO labelscan_db_admin;', namespace.nspname, object.relname) FROM pg_class object JOIN pg_namespace namespace ON namespace.oid = object.relnamespace JOIN pg_roles owner ON owner.oid = object.relowner WHERE namespace.nspname IN ('ingestion', 'compliance', 'traceability', 'haccp', 'audit', 'identity', 'platform', 'public') AND owner.rolname IN ('labelscan_app', 'labelscan_db_admin_retired_v2') AND object.relkind = 'f';" \
    '\gexec' \
    "SELECT format('ALTER %s %I.%I(%s) OWNER TO labelscan_db_admin;', CASE function.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END, namespace.nspname, function.proname, pg_get_function_identity_arguments(function.oid)) FROM pg_proc function JOIN pg_namespace namespace ON namespace.oid = function.pronamespace JOIN pg_roles owner ON owner.oid = function.proowner WHERE namespace.nspname IN ('ingestion', 'compliance', 'traceability', 'haccp', 'audit', 'identity', 'platform', 'public') AND owner.rolname IN ('labelscan_app', 'labelscan_db_admin_retired_v2');" \
    '\gexec' \
    "SELECT format('ALTER %s %I.%I OWNER TO labelscan_db_admin;', CASE WHEN type.typtype = 'd' THEN 'DOMAIN' ELSE 'TYPE' END, namespace.nspname, type.typname) FROM pg_type type JOIN pg_namespace namespace ON namespace.oid = type.typnamespace JOIN pg_roles owner ON owner.oid = type.typowner WHERE namespace.nspname IN ('ingestion', 'compliance', 'traceability', 'haccp', 'audit', 'identity', 'platform', 'public') AND owner.rolname IN ('labelscan_app', 'labelscan_db_admin_retired_v2') AND type.typrelid = 0 AND type.typelem = 0;" \
    '\gexec' \
    "SELECT format('ALTER SCHEMA %I OWNER TO labelscan_db_admin;', namespace.nspname) FROM pg_namespace namespace JOIN pg_roles owner ON owner.oid = namespace.nspowner WHERE namespace.nspname IN ('ingestion', 'compliance', 'traceability', 'haccp', 'audit', 'identity', 'platform', 'public') AND owner.rolname IN ('labelscan_app', 'labelscan_db_admin_retired_v2');" \
    '\gexec' \
    'COMMIT;' >"$sql_file"

  docker compose -f "$COMPOSE_FILE" exec -T db \
    psql -U "$bootstrap_user" -d labelscan -v ON_ERROR_STOP=1 <"$sql_file"
  docker compose -f "$COMPOSE_FILE" exec -T db \
    psql -U labelscan_db_admin -d labelscan -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE labelscan_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${runtime_password}';"
  rm -f "$sql_file"

  install_secret "${SECRETS_ROOT}/db_admin_password" "$admin_password"
  install_secret "${SECRETS_ROOT}/db_runtime_password" "$runtime_password"
  install_secret "${SECRETS_ROOT}/database_admin_url" \
    "postgresql+psycopg://labelscan_db_admin:${admin_password}@db:5432/labelscan"
  install_secret "${SECRETS_ROOT}/database_url" \
    "postgresql+psycopg://labelscan_app:${runtime_password}@db:5432/labelscan"
  install -m 600 /dev/null "$DB_ROLE_MARKER"
}

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
short_sha="${commit_sha:0:12}"
backup_file="${BACKUP_ROOT}/${timestamp}-${short_sha}.dump"
raw_backup_file="${BACKUP_ROOT}/${timestamp}-${short_sha}-raw.tar.gz"

printf '==> Backing up PostgreSQL to %s\n' "$backup_file"
docker compose -f "$COMPOSE_FILE" exec -T db \
  sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$backup_file"
chmod 600 "$backup_file"

printf '==> Backing up raw label images to %s\n' "$raw_backup_file"
docker compose -f "$COMPOSE_FILE" run --rm --no-deps \
  --entrypoint /bin/tar api -C /app/data/raw -czf - . >"$raw_backup_file"
chmod 600 "$raw_backup_file"

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
    psql -U labelscan_db_admin -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'labelscan' AND pid <> pg_backend_pid();"
  docker compose -f "$COMPOSE_FILE" exec -T db \
    psql -U labelscan_db_admin -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE labelscan;'
  docker compose -f "$COMPOSE_FILE" exec -T db \
    psql -U labelscan_db_admin -d postgres -v ON_ERROR_STOP=1 \
    -c 'CREATE DATABASE labelscan OWNER labelscan_db_admin;'
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
  local exit_code=$?
  if [[ -n "${sql_file:-}" && -f "$sql_file" ]]; then
    rm -f "$sql_file"
  fi
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

ensure_provider_secrets
ensure_demo_credentials
rotate_jwt_once

printf '==> Building the private image on the VPS\n'
docker compose -f "${checkout_root}/${REPOSITORY_COMPOSE}" build migrate

printf '==> Separating PostgreSQL owner and runtime roles\n'
prepare_database_roles

printf '==> Installing the reviewed single-VPS production contract\n'
install -m 600 "${checkout_root}/${REPOSITORY_COMPOSE}" "$COMPOSE_FILE"

printf '==> Recreating PostgreSQL with the owner-only service identity\n'
docker compose -f "$COMPOSE_FILE" up -d --no-deps db
docker compose -f "$COMPOSE_FILE" exec -T db \
  sh -c 'until pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do sleep 1; done'

if [[ "$reset_demo" -eq 1 ]]; then
  reset_demo_data
fi

printf '==> Applying database migrations\n'
docker compose -f "$COMPOSE_FILE" run --rm migrate

if [[ ! -f "$DEMO_CREDENTIALS_MARKER" ]]; then
  printf '==> Replacing legacy demonstration passwords without reseeding data\n'
  docker compose -f "$COMPOSE_FILE" run --rm --no-deps secure_demo_credentials
  install -m 600 /dev/null "$DEMO_CREDENTIALS_MARKER"
fi

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

printf '==> Verifying public production security gates\n'
for private_path in /docs /redoc /openapi.json; do
  status_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --max-time 10 "https://label-scan.fr${private_path}")"
  [[ "$status_code" == "404" ]] || die "${private_path} is public (HTTP ${status_code})"
done

[[ "$response" != *'"checks"'* ]] || die "readiness leaks internal dependency details"

status_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --max-time 10 "https://label-scan.fr/v1/arrivals")"
[[ "$status_code" == "401" ]] || die "protected API accepted an anonymous request"

status_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --max-time 10 -H 'X-Actor-Id: 11111111-1111-1111-1111-111111111111' \
  -H 'X-Actor-Scopes: catalog:read admin' \
  "https://label-scan.fr/v1/arrivals")"
[[ "$status_code" == "401" ]] || die "protected API accepted forged identity headers"

status_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --max-time 10 -X POST -H 'Content-Type: application/json' \
  -H 'Origin: https://example.invalid' \
  --data '{"username":"production-security-probe","password":"invalid-probe-password"}' \
  "https://label-scan.fr/v1/auth/login")"
[[ "$status_code" == "403" ]] || die "browser login accepted a foreign Origin"

trap - ERR

printf '%s %s\n' "$timestamp" "$commit_sha" >"${APP_ROOT}/DEPLOYED_VERSION"
chmod 600 "${APP_ROOT}/DEPLOYED_VERSION"

# Keep the fourteen most recent database + raw-image backup pairs. Paths are
# tightly scoped to LabelScan's private backup directory.
find "$BACKUP_ROOT" -maxdepth 1 -type f \( -name '*.dump' -o -name '*-raw.tar.gz' \) -printf '%T@ %p\n' \
  | sort -rn \
  | tail -n +29 \
  | cut -d' ' -f2- \
  | xargs -r rm --

docker compose -f "$COMPOSE_FILE" ps
printf '==> Deployment %s is healthy\n' "$short_sha"
