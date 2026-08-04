# syntax=docker/dockerfile:1

# Tags remain readable while digests make the build input reproducible and
# reviewable. Dependabot covers Docker base-image updates.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS web-builder

WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build


FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91 AS builder

WORKDIR /build

COPY server/pyproject.toml ./
COPY server/requirements.lock ./
COPY server/src/ src/

RUN pip install --no-cache-dir --require-hashes --prefix=/install -r requirements.lock \
    && pip install --no-cache-dir --no-deps --prefix=/install .


FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN addgroup --system --gid 10001 app \
    && adduser --system --uid 10001 --ingroup app --no-create-home app

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
CMD ["api"]
