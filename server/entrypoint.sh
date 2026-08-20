#!/bin/sh
set -eu

role="${1:-api}"

case "$role" in
  migrate)
    echo "==> Applying database migrations"
    exec alembic upgrade head
    ;;
  api)
    echo "==> Starting API"
    exec uvicorn labelscan.app.http_app:create_app --factory \
      --host 0.0.0.0 --port 8000 --no-proxy-headers \
      --no-server-header --no-date-header
    ;;
  worker)
    echo "==> Starting extraction worker"
    exec python -m labelscan.app.worker_runtime
    ;;
  demo)
    echo "==> Installing demonstration data"
    exec python /app/scripts/seed_demo.py
    ;;
  secure-demo-credentials)
    echo "==> Securing demonstration account credentials"
    exec python /app/scripts/secure_demo_credentials.py
    ;;
  *)
    echo "unsupported process role: $role" >&2
    exit 64
    ;;
esac
