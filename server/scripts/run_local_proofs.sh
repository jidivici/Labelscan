#!/usr/bin/env bash
# Local PG-1 proof runner: spins up an ephemeral PostgreSQL 16, applies the
# migrations, runs the G-ARCH boundary check, then runs the immutability/audit/
# rollback proofs. Self-contained and cleans up after itself.
#
# Usage:  bash server/scripts/run_local_proofs.sh
set -euo pipefail

PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
PORT="${PGPORT:-54329}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # server/
DATADIR="$(mktemp -d "${TMPDIR:-/tmp}/labelscan_pg.XXXXXX")"
SOCKDIR="$(mktemp -d "${TMPDIR:-/tmp}/labelscan_sock.XXXXXX")"

cleanup() {
  "$PG_BIN/pg_ctl" -D "$DATADIR" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DATADIR" "$SOCKDIR"
}
trap cleanup EXIT

echo "==> initdb"
"$PG_BIN/initdb" -D "$DATADIR" -U postgres --auth=trust >/dev/null

echo "==> start postgres on :$PORT"
"$PG_BIN/pg_ctl" -D "$DATADIR" \
  -o "-p $PORT -k $SOCKDIR -c listen_addresses=127.0.0.1" \
  -w start >/dev/null

createdb_url="postgresql://postgres@127.0.0.1:$PORT/postgres"
"$PG_BIN/psql" "$createdb_url" -v ON_ERROR_STOP=1 -c "CREATE DATABASE labelscan_test;" >/dev/null

export DATABASE_URL="postgresql+psycopg://postgres@127.0.0.1:$PORT/labelscan_test"
echo "==> DATABASE_URL=$DATABASE_URL"

cd "$HERE"
echo "==> install deps"
python3 -m pip install --quiet -e ".[dev]"

echo "==> alembic upgrade head"
python3 -m alembic upgrade head

echo "==> G-ARCH: lint-imports (dependency boundaries)"
lint-imports

echo "==> proofs: immutability / audit / rollback"
python3 -m pytest -v

echo "==> ALL PROOFS PASSED"
