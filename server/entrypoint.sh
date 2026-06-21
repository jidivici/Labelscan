#!/bin/bash
set -e

echo "==> Running Alembic migrations..."
alembic upgrade head

echo "==> Starting server..."
exec uvicorn labelscan.app.http_app:create_app --factory --host 0.0.0.0 --port 8000
