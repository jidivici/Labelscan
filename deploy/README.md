# Deploying LabelScan

This guide explains the production contracts stored in `deploy/`. It is for the person
preparing or reviewing a release. The files in this directory describe what the
repository can configure; they do not prove that a real environment is secure, backed
up, monitored, or ready for users.

Before exposing an environment, complete the
[production validation guide](../docs/security/PRODUCTION-VALIDATION.md) and the
[pre-pentest checklist](../docs/security/PRE-PENTEST-CHECKLIST.md). Start with the
[open-risk register](../docs/security/THREAT-MODEL.md#confirmed-open-risk-register), which
is the single prioritized source for current blockers.

## Choose one topology

LabelScan contains two deliberately different Compose profiles.

| Profile | What it runs | What you must provide outside Compose |
|---|---|---|
| [`compose/production.yml`](compose/production.yml) | API, one worker, and a one-shot migration job | Managed PostgreSQL, private S3-compatible storage, a TLS edge, two external Docker networks, and external Docker secrets |
| [`compose/single-vps.yml`](compose/single-vps.yml) | Caddy, API, workers, PostgreSQL, migrations, and local raw-image storage | A hardened Hostinger VPS, root-owned secret files, host firewalling, off-host backups, monitoring, and incident response |

The application validates the selected topology at startup. Managed production requires
PostgreSQL transport encryption and S3-compatible storage protected with a Key Management
Service (KMS) key. The single-VPS profile requires the private `db` service and the raw-image
path `/app/data/raw`. Runtime configuration defaults an unset topology to `managed`; the
single-VPS Compose file sets `single-vps` explicitly.

## Managed infrastructure

The managed profile is an integration contract, not a complete platform.

```text
Internet
   │
   ▼
TLS edge ── external edge network ── API
                                          \
external backend network ────────────────── PostgreSQL + private S3
                  │
                  └── worker ── Google Vision + Anthropic
```

Only the edge should be reachable from the internet. `production.yml` publishes no host
port: the API only exposes port `8000` to the external edge network. The external backend
network must enforce the database, storage, and provider egress policy that Compose does
not define.

### Required inputs

Create a production environment file outside Git from
[`env/production.env.example`](env/production.env.example). It contains only non-secret
settings:

- `LABELSCAN_IMAGE` identifies the reviewed application image. Use a registry digest,
  not a mutable tag.
- `LABELSCAN_PUBLIC_ORIGIN`, `LABELSCAN_ALLOWED_HOSTS`, and
  `LABELSCAN_TRUSTED_PROXIES` define the browser and reverse-proxy boundary.
- `LABELSCAN_S3_*` identifies the private bucket, region, HTTPS endpoint when needed,
  and KMS key.
- `LABELSCAN_EDGE_NETWORK` and `LABELSCAN_BACKEND_NETWORK` name networks created outside
  this Compose project.
- `LABELSCAN_VERSION` identifies the release returned by `/v1/version`.

The profile expects external secrets for the database URL, JWT signing key, Google Vision
key, and Anthropic key. The database URL must use `sslmode=verify-full`.

### Important database-role limitation

The current managed Compose file mounts the same `database_url` secret into `migrate`,
`api`, and `worker`. It therefore does **not** implement the owner/runtime credential split
that the database hardening model expects. A connection powerful enough to run migrations
is too powerful for the long-running services; a least-privilege runtime connection cannot
run every migration.

Do not present this profile as least-privilege production until the deployment contract
provides separate migration-owner and runtime secrets. The single-VPS profile already has
that separation. This is a repository limitation, not something an infrastructure
attestation can make true after the fact.

### Validate and release

First render the contract with the real non-secret environment file. This catches missing
variables and invalid Compose structure without starting services:

```bash
docker compose \
  --env-file /secure/path/labelscan-production.env \
  -f deploy/compose/production.yml \
  config --quiet
```

Once the database-role limitation above has been resolved, a release should follow this
order:

1. Build from the reviewed commit, audit dependencies, scan the image, create a software
   bill of materials (SBOM), sign the image, and publish the exact digest.
2. Verify the external networks, TLS edge, bucket policy, KMS key, database transport,
   and secret ACLs.
3. Run the migration job once and require a successful exit.
4. Start one API process and the worker. The rate limiter and long-poll counters are
   process-local, so additional API replicas change the abuse-control behavior.
5. Run readiness, authentication, upload, host, origin, and response-header checks from
   outside the platform.
6. Record evidence in the production validation and pre-pentest checklists.

There is no repository workflow that deploys the managed profile. The infrastructure
owner must provide release automation, rollback, backups, monitoring, and access control.

## Hostinger single VPS

The single-VPS profile is the repository's automated Hostinger path. It keeps the API,
workers, database, proxy, and raw-image volume on one host.

```text
Internet ── Caddy ── edge network ── API
                                      │
                         internal backend network
                           ├── PostgreSQL
                           └── workers
                                 │
                            egress network
                           Google + Anthropic
```

### Network boundaries

| Network | Members | Current behavior |
|---|---|---|
| `edge` | Caddy and API | Caddy can reach the API; only Caddy publishes host ports |
| `backend` | API, workers, and PostgreSQL | Docker marks it internal; PostgreSQL has no host port |
| `egress` | Workers | Allows outbound provider traffic, but does not restrict destinations |

The `egress` network is separation, not an allow-list. Enforce approved destinations with
host or upstream firewall policy and verify the result with flow logs or an equivalent
network test.

Caddy uses the reviewed [`caddy/Caddyfile`](caddy/Caddyfile). It redirects HTTP to HTTPS,
rejects unknown HTTP hosts, applies HTTP Strict Transport Security (HSTS) and other public
security headers, and caps the multipart envelope at 11 MiB. The API separately limits the
uploaded image file to 10 MiB and
accepts JPEG, PNG, and WebP.

`LABELSCAN_TRUSTED_PROXIES` is currently the private `172.16.0.0/12` range in this profile,
not one fixed Caddy address. Keep untrusted containers off the edge network and test
forwarded-address handling whenever network membership changes.

The VPS filesystem raw store derives object paths from the content hash only; it does not
include `organization_id`. API and PostgreSQL authorization still scope ordinary access,
but the volume layout is not a tenant boundary. Managed S3 uses organization-prefixed
keys. Account for this defense-in-depth difference when selecting a topology and planning
the storage migration tracked as OR-11 in the open-risk register.

The managed S3 adapter verifies SHA-256 when it reads an object. The VPS filesystem readers
currently trust the checksum-derived path without recomputing the bytes. Until OR-15 is
closed, add an independent integrity check and treat a mismatch as a restore/security
incident; ordinary readiness proves only that the directory is writable.

### What the release workflow does

[`deploy-hostinger.yml`](../.github/workflows/deploy-hostinger.yml) runs for an explicit
manual dispatch, or for a push to `main` whose commit message contains
`[deploy production]`. It first revalidates the exact revision on a hosted runner, then
hands that revision to a labelled self-hosted production runner.

The continuous-integration release gate currently checks:

- mobile configuration, TypeScript, tests, and npm dependencies;
- back-office types, tests, build, browser tests, and npm dependencies;
- backend dependencies, import boundaries, lint, OpenAPI inventory, reversible
  migrations, and tests;
- application, Caddy, and PostgreSQL image builds and Open Container Initiative (OCI)
  revision labels;
- PostgreSQL volume compatibility, Trivy image/configuration scans, Caddy validation,
  Compose rendering, and shell syntax.

It does not build a signed Android or iOS release artifact, generate an SBOM, or sign the
three VPS images. Add those proofs separately when required by the release policy.

On the VPS, [`hostinger/deploy.sh`](hostinger/deploy.sh):

1. accepts only a clean checkout at the requested full Git commit;
2. prevents concurrent deployments with a host lock;
3. saves the current Compose/Caddy contracts and commit-addressed images for rollback;
4. creates a PostgreSQL dump and raw-image archive before changing the release;
5. builds application, Caddy, and PostgreSQL images from the checked commit and verifies
   their OCI revision labels;
6. maintains separate database-owner and runtime credentials;
7. validates Caddy, applies migrations with the owner credential, and starts one API plus
   two workers with the runtime credential;
8. checks readiness, release identity, private documentation routes, anonymous and forged
   authentication, browser origin, redirect safety, public headers, unknown hosts, and an
   oversized upload;
9. retains the 28 newest database dump or raw-image archive files on the VPS; cleanup
   is file-based and does not reconstruct a pair whose other member is missing.

Normal releases preserve the existing demo data. The manual `reset_demo` input is accepted
only when its value is exactly `RESET_DEMO`; it recreates the database and raw-image data.
That operation is intentionally destructive and requires a coherent VPS snapshot for
recovery if it fails.

### Rollback and backup limits

The automatic error handler can restore the previous Compose file, Caddyfile, and images.
It does **not** downgrade the database after a migration. Every migration must therefore
remain compatible with the previous application during the rollback window, even though
CI also tests Alembic downgrade behavior.

The pre-release dump and image archive are stored under `/opt/labelscan/backups` on the
same VPS. They protect a release operation, but they are not disaster recovery: host loss
can remove both production data and its local backups. Copy encrypted backups off-host,
define retention and recovery objectives, and test a full restore in isolation.

### Runtime hardening

The API and worker images run with numeric user/group IDs (UID/GID) `10001`, with a
read-only root filesystem, `no-new-privileges`, no Linux capabilities, bounded
PIDs/CPU/memory, and a small
`noexec,nosuid,nodev` `/tmp`. They receive no Docker socket. Caddy runs as UID/GID
`10002`, retains only `NET_BIND_SERVICE`, and stores TLS/configuration state in dedicated
volumes. PostgreSQL runs as its image's non-root user on a writable private data volume;
it does not use the application container's read-only/capability profile.

The repository also contains reference host policies:

- [`hostinger/sshd-hardening.conf`](hostinger/sshd-hardening.conf) hardens Secure Shell
  (SSH), requires public-key authentication, and disables password login, forwarding,
  tunnelling, and X11;
- [`hostinger/fail2ban-labelscan.conf`](hostinger/fail2ban-labelscan.conf) configures an
  SSH jail using the Uncomplicated Firewall (UFW);
- [`caddy/Caddyfile`](caddy/Caddyfile) is installed and validated by the release script.

The release script installs the Caddyfile, but it does **not** install the SSH, fail2ban,
or UFW policy. Apply and validate those controls through the host-management process, with
console access available in case an SSH change locks out the operator.

## What remains external in both topologies

A successful Compose start is not a production approval. Keep evidence for TLS, network
exposure, egress restrictions, secret custody and rotation, off-host restore, monitoring,
alert delivery, dependency agreements, data retention, incident response, and an
independent security test. The repository can help test these controls; it cannot attest
that an operator has configured them.
