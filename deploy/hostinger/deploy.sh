#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_ROOT="/opt/labelscan"
readonly SOURCE_ROOT="${APP_ROOT}/source"
readonly COMPOSE_FILE="${APP_ROOT}/config/compose.yml"
readonly CADDY_FILE="${APP_ROOT}/config/Caddyfile"
readonly ROLLBACK_COMPOSE_FILE="${APP_ROOT}/config/compose.rollback.yml"
readonly ROLLBACK_CADDY_FILE="${APP_ROOT}/config/Caddyfile.rollback"
readonly REPOSITORY_COMPOSE="deploy/compose/single-vps.yml"
readonly REPOSITORY_BUILD_COMPOSE="deploy/compose/single-vps.build.yml"
readonly REPOSITORY_CADDY="deploy/caddy/Caddyfile"
readonly BACKUP_ROOT="${APP_ROOT}/backups"
readonly SECRETS_ROOT="${APP_ROOT}/secrets"
readonly APP_SECRET_GID="10001"
readonly DB_ROLE_MARKER="${APP_ROOT}/.database-roles-v4"
readonly DEMO_CREDENTIALS_MARKER="${APP_ROOT}/.demo-credentials-secured"
readonly JWT_ROTATION_MARKER="${APP_ROOT}/.jwt-secret-v2"
readonly POSTGRES_HARDENED_VOLUME_MARKER="${APP_ROOT}/.postgres-hardened-volume-v1"
readonly POSTGRES_HARDENED_VOLUME="labelscan-single-vps_postgres_data_v2"
readonly LOCK_FILE="/var/lock/labelscan-deploy.lock"
readonly HEALTH_URL="https://label-scan.fr/v1/health/ready"

die() {
  printf 'deploy error: %s\n' "$*" >&2
  exit 1
}

reset_demo=0
reset_started=0
postgres_volume_migrated=0
consistent_dump_file=""
consistent_raw_backup_file=""
source_counts_file=""
restored_counts_file=""
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
# The self-hosted runner owns the checkout while this reviewed wrapper runs as
# root. Trust only this checkout for this command; never weaken Git globally.
checkout_head="$(git -c safe.directory="$checkout_root" -C "$checkout_root" rev-parse --verify HEAD^{commit})" \
  || die "source Git revision cannot be inspected"
[[ "$checkout_head" == "$commit_sha" ]] || die "checkout does not match requested commit"
[[ -z "$(git -c safe.directory="$checkout_root" -C "$checkout_root" status --porcelain --untracked-files=all)" ]] \
  || die "deployment checkout contains changes outside the requested commit"
[[ -f "${checkout_root}/server/Dockerfile" ]] || die "server Dockerfile is missing"
[[ -f "${checkout_root}/deploy/caddy/Dockerfile" ]] || die "Caddy Dockerfile is missing"
[[ -f "${checkout_root}/deploy/postgres/Dockerfile" ]] || die "PostgreSQL Dockerfile is missing"
[[ -f "${checkout_root}/web/package-lock.json" ]] || die "web lockfile is missing"
[[ -f "${checkout_root}/${REPOSITORY_COMPOSE}" ]] || die "single-VPS Compose file is missing"
[[ -f "${checkout_root}/${REPOSITORY_BUILD_COMPOSE}" ]] || die "single-VPS build Compose file is missing"
[[ -f "${checkout_root}/${REPOSITORY_CADDY}" ]] || die "Caddyfile is missing"
[[ -f "$COMPOSE_FILE" ]] || die "VPS Compose file is missing"

previous_version=""
if [[ -s "${APP_ROOT}/DEPLOYED_VERSION" ]]; then
  previous_version="$(awk 'NF >= 2 { print $2; exit }' "${APP_ROOT}/DEPLOYED_VERSION")"
  [[ -z "$previous_version" || "$previous_version" =~ ^[0-9a-f]{40}$ ]] \
    || die "previous deployed version marker is invalid"
fi

export LABELSCAN_VERSION="$commit_sha"

exec 9>"$LOCK_FILE"
flock -n 9 || die "another deployment is already running"

# Preserve both the previous contract and the exact images that are serving
# it. This also makes the one-time transition from upstream Caddy/PostgreSQL
# images to LabelScan-built images safely reversible.
install -m 600 "$COMPOSE_FILE" "$ROLLBACK_COMPOSE_FILE"
if [[ -f "$CADDY_FILE" ]]; then
  install -m 600 "$CADDY_FILE" "$ROLLBACK_CADDY_FILE"
fi

preserve_running_image() {
  local service="$1"
  local target="$2"
  local container image
  docker image inspect "$target" >/dev/null 2>&1 && return
  container="$(docker compose -f "$COMPOSE_FILE" ps -q "$service")"
  [[ -n "$container" ]] || die "cannot identify the running ${service} image for rollback"
  image="$(docker inspect --format '{{.Image}}' "$container")"
  docker tag "$image" "$target"
}

if [[ -n "$previous_version" ]]; then
  preserve_running_image api "labelscan-local:${previous_version}"
  preserve_running_image caddy "labelscan-caddy:${previous_version}"
  preserve_running_image db "labelscan-postgres:${previous_version}"
fi

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

grant_application_secret_access() {
  local target
  for target in \
    "${SECRETS_ROOT}/database_admin_url" \
    "${SECRETS_ROOT}/database_url" \
    "${SECRETS_ROOT}/jwt_secret" \
    "${SECRETS_ROOT}/google_vision_api_key" \
    "${SECRETS_ROOT}/anthropic_api_key" \
    "${SECRETS_ROOT}/demo_credentials.json"; do
    [[ -s "$target" ]] || die "required application secret is missing: ${target}"
    chown root:"$APP_SECRET_GID" "$target"
    chmod 640 "$target"
  done
}

grant_database_secret_access() {
  local target="${SECRETS_ROOT}/db_admin_password"
  [[ -s "$target" ]] || die "required database secret is missing: ${target}"
  chown root:70 "$target"
  chmod 640 "$target"
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
docker compose -f "$COMPOSE_FILE" exec -T api \
  /bin/tar -C /app/data/raw -czf - . >"$raw_backup_file"
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

migrate_postgres_to_hardened_volume() {
  local runtime_password
  [[ -f "$POSTGRES_HARDENED_VOLUME_MARKER" ]] && return

  printf '==> Restoring PostgreSQL into the clean hardened volume\n'
  runtime_password="$(<"${SECRETS_ROOT}/db_runtime_password")"
  [[ "$runtime_password" =~ ^[0-9a-f]{96}$ ]] \
    || die "runtime database password has an unexpected format"

  printf '%s\n' \
    "SELECT 'CREATE ROLE labelscan_auditor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelscan_auditor');" \
    '\gexec' \
    "SELECT format('CREATE ROLE labelscan_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelscan_app');" \
    '\gexec' \
    "ALTER ROLE labelscan_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';" \
    | docker compose -f "$COMPOSE_FILE" exec -T db \
        psql -U labelscan_db_admin -d labelscan -v ON_ERROR_STOP=1 \
          -v "app_password=${runtime_password}" >/dev/null

  docker compose -f "$COMPOSE_FILE" exec -T db \
    pg_restore -U labelscan_db_admin -d labelscan \
      --clean --if-exists --no-owner --exit-on-error <"$backup_file"

  docker compose -f "$COMPOSE_FILE" exec -T db \
    psql -U labelscan_db_admin -d labelscan -v ON_ERROR_STOP=1 \
      -c 'REINDEX DATABASE labelscan;' \
      -c 'ANALYZE;'

  restored_counts_file="$(mktemp "${BACKUP_ROOT}/.restored-counts.XXXXXX")"
  capture_database_row_counts "$restored_counts_file"
  if ! cmp -s "$source_counts_file" "$restored_counts_file"; then
    diff -u "$source_counts_file" "$restored_counts_file" >&2 || true
    die "restored PostgreSQL table counts do not match the source database"
  fi
  printf '==> Verified restored table counts: %s\n' \
    "$(sha256sum "$restored_counts_file" | cut -d' ' -f1)"
  rm -f "$source_counts_file" "$restored_counts_file"
  source_counts_file=""
  restored_counts_file=""

  install -m 600 /dev/null "$POSTGRES_HARDENED_VOLUME_MARKER"
  postgres_volume_migrated=1
}

capture_database_row_counts() {
  local target="$1"
  docker compose -f "$COMPOSE_FILE" exec -T db \
    psql -X -U labelscan_db_admin -d labelscan -At -F '|' <<'SQL' >"$target"
SELECT format(
  'SELECT %L, count(*) FROM %I.%I;',
  schemaname || '.' || tablename,
  schemaname,
  tablename
)
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY schemaname, tablename;
\gexec
SQL
  chmod 600 "$target"
}

prepare_consistent_hardened_migration_backup() {
  [[ -f "$POSTGRES_HARDENED_VOLUME_MARKER" ]] && return

  printf '==> Quiescing writers for the one-time PostgreSQL volume migration\n'
  docker compose -f "$COMPOSE_FILE" stop api worker

  consistent_dump_file="$(mktemp "${BACKUP_ROOT}/.consistent-dump.XXXXXX")"
  docker compose -f "$COMPOSE_FILE" exec -T db \
    pg_dump -U labelscan_db_admin -d labelscan -Fc >"$consistent_dump_file"
  chmod 600 "$consistent_dump_file"
  mv -f "$consistent_dump_file" "$backup_file"
  consistent_dump_file=""

  consistent_raw_backup_file="$(mktemp "${BACKUP_ROOT}/.consistent-raw.XXXXXX")"
  docker compose -f "$COMPOSE_FILE" run --rm --no-deps --entrypoint /bin/tar api \
    -C /app/data/raw -czf - . >"$consistent_raw_backup_file"
  chmod 600 "$consistent_raw_backup_file"
  mv -f "$consistent_raw_backup_file" "$raw_backup_file"
  consistent_raw_backup_file=""

  source_counts_file="$(mktemp "${BACKUP_ROOT}/.source-counts.XXXXXX")"
  capture_database_row_counts "$source_counts_file"
}

reset_incomplete_hardened_postgres_volume() {
  local project_label volume_label
  [[ -f "$POSTGRES_HARDENED_VOLUME_MARKER" ]] && return

  printf '==> Recreating the unvalidated PostgreSQL migration volume\n'
  docker compose -f "$COMPOSE_FILE" stop db
  docker compose -f "$COMPOSE_FILE" rm -f db
  if ! docker volume inspect "$POSTGRES_HARDENED_VOLUME" >/dev/null 2>&1; then
    return
  fi
  project_label="$(docker volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' \
    "$POSTGRES_HARDENED_VOLUME")"
  volume_label="$(docker volume inspect --format '{{ index .Labels "com.docker.compose.volume" }}' \
    "$POSTGRES_HARDENED_VOLUME")"
  [[ "$project_label" == "labelscan-single-vps" && "$volume_label" == "postgres_data_v2" ]] \
    || die "refusing to replace an unrecognized PostgreSQL volume"
  docker volume rm "$POSTGRES_HARDENED_VOLUME" >/dev/null
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
  "${checkout_root}/deploy" \
  "${checkout_root}/server" \
  "${checkout_root}/web" \
  "${SOURCE_ROOT}/"

rollback_image() {
  local exit_code=$?
  if [[ -n "${oversized_probe:-}" && -f "$oversized_probe" ]]; then
    rm -f "$oversized_probe"
  fi
  if [[ -n "${sql_file:-}" && -f "$sql_file" ]]; then
    rm -f "$sql_file"
  fi
  for temporary in \
    "$consistent_dump_file" \
    "$consistent_raw_backup_file" \
    "$source_counts_file" \
    "$restored_counts_file"; do
    if [[ -n "$temporary" && -f "$temporary" ]]; then
      rm -f "$temporary"
    fi
  done
  if [[ "$postgres_volume_migrated" -eq 1 ]]; then
    rm -f "$POSTGRES_HARDENED_VOLUME_MARKER"
  fi
  if [[ "$reset_started" -eq 1 ]]; then
    # A reset replaces both PostgreSQL and raw data. Reverting only the image
    # would combine old code with a new schema/data set; the VPS snapshot is
    # the coherent recovery point for this exceptional operation.
    printf '==> Reset deployment failed; use the VPS snapshot to recover a coherent pre-reset state\n' >&2
    exit "$exit_code"
  fi
  if [[ -n "$previous_version" ]] \
    && docker image inspect "labelscan-local:${previous_version}" >/dev/null 2>&1; then
    printf '==> Deployment failed; restoring the previous production contract\n' >&2
    install -m 600 "$ROLLBACK_COMPOSE_FILE" "$COMPOSE_FILE"
    if [[ -f "$ROLLBACK_CADDY_FILE" ]]; then
      install -m 600 "$ROLLBACK_CADDY_FILE" "$CADDY_FILE"
    fi
    export LABELSCAN_VERSION="$previous_version"
    docker compose -f "$COMPOSE_FILE" up -d --no-deps db || true
    docker compose -f "$COMPOSE_FILE" exec -T db \
      sh -c 'until pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do sleep 1; done' || true
    docker compose -f "$COMPOSE_FILE" up -d --no-deps --scale worker=2 api worker caddy || true
  fi
  exit "$exit_code"
}
trap rollback_image ERR

ensure_provider_secrets
ensure_demo_credentials
rotate_jwt_once

printf '==> Building the private production images on the VPS\n'
docker compose \
  -f "${checkout_root}/${REPOSITORY_COMPOSE}" \
  -f "${checkout_root}/${REPOSITORY_BUILD_COMPOSE}" \
  build --pull --no-cache migrate caddy db
for image_name in labelscan-local labelscan-caddy labelscan-postgres; do
  image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
    "${image_name}:${commit_sha}")"
  [[ "$image_revision" == "$commit_sha" ]] \
    || die "${image_name} revision label does not match the requested commit"
done

printf '==> Separating PostgreSQL owner and runtime roles\n'
prepare_database_roles
grant_database_secret_access
grant_application_secret_access

printf '==> Installing the reviewed single-VPS production contract\n'
install -m 600 "${checkout_root}/${REPOSITORY_COMPOSE}" "$COMPOSE_FILE"
install -o root -g 10002 -m 640 "${checkout_root}/${REPOSITORY_CADDY}" "$CADDY_FILE"

printf '==> Validating the reviewed reverse-proxy contract\n'
docker run --rm --network none --user 10002:10002 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \
  -v "${CADDY_FILE}:/etc/caddy/Caddyfile:ro" \
  "labelscan-caddy:${commit_sha}" \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile

printf '==> Assigning Caddy state volumes to its non-root runtime identity\n'
docker compose -f "$COMPOSE_FILE" stop caddy
docker compose -f "$COMPOSE_FILE" run --rm --no-deps --user 0:0 \
  --cap-add CHOWN --cap-add DAC_OVERRIDE \
  --entrypoint /bin/sh caddy -c 'chown -R 10002:10002 /data /config'

prepare_consistent_hardened_migration_backup
reset_incomplete_hardened_postgres_volume

printf '==> Recreating PostgreSQL with the owner-only service identity\n'
docker compose -f "$COMPOSE_FILE" up -d --no-deps db
docker compose -f "$COMPOSE_FILE" exec -T db \
  sh -c 'until pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do sleep 1; done'

migrate_postgres_to_hardened_volume

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

version_response="$(curl --fail --silent --show-error --max-time 10 \
  "https://label-scan.fr/v1/version")"
[[ "$version_response" == *"${commit_sha}"* ]] || die "public version does not match the deployed commit"

redirect_headers="$(curl --silent --show-error --head --max-redirs 0 --max-time 10 \
  "https://label-scan.fr/backoffice")"
redirect_location="$(printf '%s\n' "$redirect_headers" \
  | sed -n 's/^[Ll]ocation:[[:space:]]*//p' | tr -d '\r' | tail -n 1)"
[[ "$redirect_location" == "/backoffice/" || "$redirect_location" == "https://label-scan.fr/backoffice/" ]] \
  || die "backoffice slash redirect is not HTTPS-safe: ${redirect_location:-missing}"

status_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --max-time 10 -H 'Host: evil.example' "http://127.0.0.1/v1/health/live")"
[[ "$status_code" == "421" ]] || die "unknown HTTP Host was not rejected (HTTP ${status_code})"

security_headers="$(curl --silent --show-error --dump-header - --output /dev/null \
  --max-time 10 "https://label-scan.fr/v1/health/live")"
for header_name in strict-transport-security x-content-type-options referrer-policy; do
  header_count="$(printf '%s\n' "$security_headers" | grep -Eic "^${header_name}:" || true)"
  [[ "$header_count" == "1" ]] || die "${header_name} is missing or duplicated (${header_count})"
done

oversized_probe="$(mktemp /tmp/labelscan-oversized-probe.XXXXXX)"
chmod 600 "$oversized_probe"
truncate -s 12582912 "$oversized_probe"
status_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --max-time 30 -X POST -F "file=@${oversized_probe};filename=oversized.jpg;type=image/jpeg" \
  "https://label-scan.fr/v1/ingestions")"
rm -f "$oversized_probe"
oversized_probe=""
[[ "$status_code" == "413" ]] || die "reverse proxy accepted an oversized anonymous upload (HTTP ${status_code})"

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
