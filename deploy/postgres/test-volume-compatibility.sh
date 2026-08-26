#!/usr/bin/env bash
set -Eeuo pipefail

readonly SOURCE_IMAGE="postgres:16.15@sha256:c1b3783309b6499c795eed7c20135a1a4d25cae1b575c3d52c6f536129a1b109"
readonly TARGET_IMAGE="${1:?usage: $0 <target-image>}"

suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
suffix="${suffix//[^a-zA-Z0-9_.-]/-}"
readonly SOURCE_CONTAINER="labelscan-pg-source-${suffix}"
readonly TARGET_CONTAINER="labelscan-pg-target-${suffix}"
readonly SOURCE_VOLUME="labelscan-pg-source-${suffix}"
readonly TARGET_VOLUME="labelscan-pg-target-${suffix}"
readonly TEST_PASSWORD="temporary-compatibility-test-only"
readonly TEST_ADMIN="labelscan_db_admin"
readonly TEST_RUNTIME="labelscan_app"

cleanup() {
  docker rm -f "$SOURCE_CONTAINER" "$TARGET_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$SOURCE_VOLUME" "$TARGET_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_postgres() {
  local container="$1"
  local attempt
  for attempt in $(seq 1 60); do
    if [[ "$(docker exec "$container" psql -U "$TEST_ADMIN" -d compatibility -Atc \
      'SELECT 1;' 2>/dev/null || true)" == "1" ]]; then
      return
    fi
    sleep 1
  done
  docker logs "$container" >&2 || true
  return 1
}

capture_row_counts() {
  local container="$1"
  docker exec -i "$container" psql -X -U "$TEST_ADMIN" -d compatibility -At -F '|' <<'SQL'
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
}

docker volume create "$SOURCE_VOLUME" >/dev/null
docker volume create "$TARGET_VOLUME" >/dev/null
docker run -d --name "$SOURCE_CONTAINER" \
  -e POSTGRES_USER="$TEST_ADMIN" \
  -e POSTGRES_PASSWORD="$TEST_PASSWORD" \
  -e POSTGRES_DB=compatibility \
  -v "${SOURCE_VOLUME}:/var/lib/postgresql/data" \
  "$SOURCE_IMAGE" >/dev/null
wait_for_postgres "$SOURCE_CONTAINER"

docker exec "$SOURCE_CONTAINER" psql -U "$TEST_ADMIN" -d compatibility -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE ${TEST_RUNTIME} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;" \
  -c 'CREATE TABLE compatibility_probe (id integer PRIMARY KEY, payload text NOT NULL);' \
  -c "INSERT INTO compatibility_probe VALUES (1, 'étiquette sûre');" \
  -c "GRANT SELECT ON compatibility_probe TO ${TEST_RUNTIME};" >/dev/null
source_counts="$(capture_row_counts "$SOURCE_CONTAINER")"

docker run -d --name "$TARGET_CONTAINER" \
  -e POSTGRES_USER="$TEST_ADMIN" \
  -e POSTGRES_PASSWORD="$TEST_PASSWORD" \
  -e POSTGRES_DB=compatibility \
  -v "${TARGET_VOLUME}:/var/lib/postgresql/data" \
  "$TARGET_IMAGE" >/dev/null
wait_for_postgres "$TARGET_CONTAINER"

printf '%s\n' \
  "SELECT format('CREATE ROLE ${TEST_RUNTIME} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TEST_RUNTIME}');" \
  '\gexec' \
  "ALTER ROLE ${TEST_RUNTIME} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';" \
  | docker exec -i "$TARGET_CONTAINER" psql -U "$TEST_ADMIN" -d compatibility \
      -v ON_ERROR_STOP=1 -v "app_password=${TEST_PASSWORD}" >/dev/null

docker exec "$SOURCE_CONTAINER" pg_dump -U "$TEST_ADMIN" -d compatibility -Fc \
  | docker exec -i "$TARGET_CONTAINER" pg_restore -U "$TEST_ADMIN" -d compatibility \
      --clean --if-exists --no-owner --exit-on-error

probe="$(docker exec "$TARGET_CONTAINER" psql -U "$TEST_RUNTIME" -d compatibility -Atc \
  'SELECT id || chr(58) || payload FROM compatibility_probe;')"
[[ "$probe" == '1:étiquette sûre' ]]
target_counts="$(capture_row_counts "$TARGET_CONTAINER")"
[[ "$target_counts" == "$source_counts" ]]

docker exec "$TARGET_CONTAINER" psql -U "$TEST_ADMIN" -d compatibility -v ON_ERROR_STOP=1 \
  -c 'REINDEX DATABASE compatibility;' \
  -c 'ANALYZE compatibility_probe;' >/dev/null

printf 'PostgreSQL Debian-to-Alpine logical migration: OK\n'
