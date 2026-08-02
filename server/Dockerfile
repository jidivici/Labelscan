FROM node:22-alpine AS web-builder

WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build


FROM python:3.13-slim AS builder

WORKDIR /build

COPY server/pyproject.toml ./
COPY server/src/ src/

RUN pip install --no-cache-dir --prefix=/install .


FROM python:3.13-slim

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

COPY --from=builder /install /usr/local
COPY server/alembic.ini ./
COPY server/migrations/ migrations/
COPY server/scripts/ scripts/
COPY --from=web-builder /web/dist/ static/
COPY server/static/assets/labelscan-logo.png static/assets/labelscan-logo.png
COPY server/entrypoint.sh ./

RUN mkdir -p /app/data/raw && chown app:app /app/data/raw

RUN chmod +x /app/entrypoint.sh

USER app

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/v1/health/live')" || exit 1

EXPOSE 8000

ENTRYPOINT ["/app/entrypoint.sh"]
