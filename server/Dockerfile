# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

# Tags remain readable while digests make the build input reproducible and
# reviewable. Dependabot covers Docker base-image updates.
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS web-builder

WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN apk upgrade --no-cache \
    && npm ci
COPY web/ ./
RUN npm run build


FROM python:3.13-alpine@sha256:540c7d91f98ff6880174c40e99067bf5941eb54d818a7a5e094d188b196a934d AS builder

WORKDIR /build

COPY server/pyproject.toml ./
COPY server/requirements.lock ./
COPY server/src/ src/

RUN apk upgrade --no-cache \
    && pip install --no-cache-dir --require-hashes --prefix=/install -r requirements.lock \
    && pip install --no-cache-dir --no-deps --prefix=/install .


FROM python:3.13-alpine@sha256:540c7d91f98ff6880174c40e99067bf5941eb54d818a7a5e094d188b196a934d

ARG LABELSCAN_VERSION=unknown
LABEL org.opencontainers.image.title="LabelScan API" \
      org.opencontainers.image.revision="$LABELSCAN_VERSION" \
      org.opencontainers.image.source="https://github.com/jidivici/Labelscan"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apk upgrade --no-cache \
    && python -m pip uninstall --yes pip \
    && rm -rf /usr/local/lib/python3.13/ensurepip \
    && test ! -e /usr/local/bin/pip \
    && addgroup -S -g 10001 app \
    && adduser -S -D -H -u 10001 -G app app

COPY --from=builder /install /usr/local
COPY server/alembic.ini ./
COPY server/migrations/ migrations/
COPY server/scripts/ scripts/
COPY server/demo/ demo/
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
