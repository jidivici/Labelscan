# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

FROM golang:1.26.6-alpine@sha256:3889b425f035be855a72fb4755265311293b6d414521f0a519d819df32222d83 AS gosu-builder

ARG GOSU_COMMIT=6456aaa0f3c854d199d0f037f068eb97515b7513

WORKDIR /src

RUN apk upgrade --no-cache \
    && apk add --no-cache git

RUN git init \
    && git remote add origin https://github.com/tianon/gosu.git \
    && git fetch --depth=1 origin "$GOSU_COMMIT" \
    && git checkout --detach "$GOSU_COMMIT" \
    && test "$(git rev-parse HEAD)" = "$GOSU_COMMIT" \
    && go get golang.org/x/sys@v0.45.0 \
    && go mod tidy \
    && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w -buildid=' -o /usr/local/bin/gosu .


FROM postgres:16.15-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685

ARG LABELSCAN_VERSION=unknown
LABEL org.opencontainers.image.title="LabelScan PostgreSQL" \
      org.opencontainers.image.revision="$LABELSCAN_VERSION" \
      org.opencontainers.image.source="https://github.com/jidivici/Labelscan"

RUN apk upgrade --no-cache

COPY --from=gosu-builder /usr/local/bin/gosu /usr/local/bin/gosu

RUN chmod 0755 /usr/local/bin/gosu \
    && ln -sf gosu /usr/local/bin/su-exec \
    && gosu --version \
    && gosu nobody true

USER postgres

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" || exit 1
