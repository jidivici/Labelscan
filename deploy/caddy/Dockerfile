# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

FROM golang:1.26.6-alpine@sha256:3889b425f035be855a72fb4755265311293b6d414521f0a519d819df32222d83 AS builder

ARG CADDY_BASE_COMMIT=e2eee6a7fce366321294c9c2a79f3146891dcbdf
ARG CADDY_SECURITY_COMMIT=1830809afe8c95c6c554740f8719e023415f85cb
ARG CADDY_CEL_COMMIT=b2693fb63a30e6d7be0972c3645e9a2c0a500e93

WORKDIR /src

RUN apk upgrade --no-cache \
    && apk add --no-cache git

RUN git init \
    && git remote add origin https://github.com/caddyserver/caddy.git \
    && git fetch --depth=1 origin "$CADDY_BASE_COMMIT" \
    && git checkout --detach "$CADDY_BASE_COMMIT" \
    && test "$(git rev-parse HEAD)" = "$CADDY_BASE_COMMIT" \
    && git fetch --depth=2 origin "$CADDY_SECURITY_COMMIT" \
    && git cherry-pick --no-commit "$CADDY_SECURITY_COMMIT" \
    && git fetch --depth=2 origin "$CADDY_CEL_COMMIT" \
    && git cherry-pick --no-commit "$CADDY_CEL_COMMIT" \
    && git diff --check \
    && git config user.name "LabelScan Security" \
    && git config user.email "security@label-scan.fr" \
    && git commit -am "Backport Caddy security and dependency compatibility fixes" \
    && git tag "v2.11.4+labelscan.2"

RUN go get \
      github.com/google/cel-go@v0.29.2 \
      golang.org/x/crypto@v0.55.0 \
      golang.org/x/net@v0.57.0 \
      golang.org/x/text@v0.41.0 \
      google.golang.org/grpc@v1.82.1 \
    && go mod tidy \
    && go test ./modules/caddyhttp/reverseproxy

WORKDIR /build
COPY deploy/caddy/main.go /build/main.go

RUN go mod init labelscan.local/caddy-build \
    && go mod edit -require=github.com/caddyserver/caddy/v2@v2.11.4 \
    && go mod edit -replace=github.com/caddyserver/caddy/v2=/src \
    && go mod tidy \
    && go list -deps . > /tmp/caddy-dependencies \
    && if grep -E '^golang.org/x/crypto/openpgp(/|$)' /tmp/caddy-dependencies; then exit 1; fi \
    && CGO_ENABLED=0 go build -trimpath \
      -ldflags='-s -w -buildid= -X github.com/caddyserver/caddy/v2.CustomVersion=v2.11.4+labelscan.2' \
      -o /usr/bin/caddy . \
    && go version -m /usr/bin/caddy \
      | grep -E 'github\.com/caddyserver/caddy/v2[[:space:]]+v2\.11\.4' \
    && go version -m /usr/bin/caddy \
      | grep -E 'golang\.org/x/crypto[[:space:]]+v0\.55\.0'


FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

ARG LABELSCAN_VERSION=unknown
LABEL org.opencontainers.image.title="LabelScan Caddy edge" \
      org.opencontainers.image.revision="$LABELSCAN_VERSION" \
      org.opencontainers.image.source="https://github.com/jidivici/Labelscan" \
      org.opencontainers.image.version="2.11.4+labelscan.2"

RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates tzdata \
    && addgroup -S -g 10002 caddy \
    && adduser -S -D -H -u 10002 -G caddy caddy \
    && install -d -o caddy -g caddy -m 0750 /config /data /srv

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

ENV XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/data

WORKDIR /srv
USER 10002:10002

EXPOSE 80 443 443/udp 2019

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --spider http://127.0.0.1:2018/health || exit 1

ENTRYPOINT ["caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
