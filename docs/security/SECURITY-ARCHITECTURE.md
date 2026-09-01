# Production security architecture

This document describes the controls implemented by the current LabelScan code and
deployment contracts. It does not certify a running environment. Network policy, secret
custody, TLS posture, backups, monitoring, provider agreements, and incident readiness
need separate evidence in the [pre-pentest checklist](PRE-PENTEST-CHECKLIST.md).
The [threat model](THREAT-MODEL.md#confirmed-open-risk-register) is the canonical,
prioritized source for confirmed open risks and release blockers.

The executable deployment sources are:

- [`deploy/compose/production.yml`](../../deploy/compose/production.yml) for externally
  managed infrastructure;
- [`deploy/compose/single-vps.yml`](../../deploy/compose/single-vps.yml) and
  [`deploy/caddy/Caddyfile`](../../deploy/caddy/Caddyfile) for the Hostinger VPS;
- `server/src/labelscan/platform/config.py` for production startup validation;
- `server/migrations/` for database roles, grants, triggers, constraints, and RLS.

## Security design in one view

LabelScan keeps the backend as a modular monolith so identity, ingestion, audit, and
outbox writes can use PostgreSQL transactions without introducing service-to-service
credentials or distributed consistency. The API and worker are separate processes: only
the worker receives OCR/LLM credentials and makes provider calls.

```text
Mobile / browser
       │ HTTPS
       ▼
TLS edge ── private hop ── API ── PostgreSQL
                               └── raw-image storage

Worker ── PostgreSQL + raw storage
   ├── Google Vision
   └── Anthropic

Migration job ── PostgreSQL owner connection ── exits
```

No diagram proves exposure. The managed edge and networks are external. On the VPS,
Caddy is the only service that publishes host ports; PostgreSQL, API, and workers stay on
Docker networks.

## Two production topologies

| Property | Managed profile | Hostinger single VPS |
|---|---|---|
| TLS edge | External and not defined by Compose | Caddy from this repository |
| PostgreSQL | External; URL must use `sslmode=verify-full` | Private `db` container; no host port, no database TLS inside the Docker network |
| Raw images | Private S3-compatible bucket with KMS settings | Private persistent Docker volume at `/app/data/raw` |
| Secrets | External Docker secret objects | Root-owned files under `/opt/labelscan/secrets` mounted only into named services |
| Database roles | **Gap:** one Compose secret is shared by migration and runtime | Separate owner/migration and restricted runtime credentials |
| Backups | Entirely external | Pre-release dump/archive on the VPS; off-host copy remains external |
| Egress control | External network policy | Worker-only egress network, but no destination allow-list in Compose |

The managed database-secret gap prevents that profile from meeting the documented
least-privilege role split in the current managed profile. Do not mark the control
complete until the Compose contract has separate owner and runtime secrets.

## Trust boundaries and controls

| Boundary | Repository controls | Evidence still needed |
|---|---|---|
| Internet → edge | Host allow-list in the app; Hostinger HTTP redirect, HSTS, unknown-host rejection, and 11 MiB multipart cap | External port scan, TLS report, certificate renewal test, WAF/rate-limit policy if used |
| Edge → API | No API host port in production Compose; explicit allowed hosts/proxies; foreign browser origin rejected on cookie-auth routes | Network membership and forwarded-header tests from trusted and untrusted peers |
| Client → identity | PBKDF2 password hashing, generic login failure, signed short-lived JWT, server-side session check, rotating hashed refresh token | Account lifecycle review, credential policy, MFA decision, abuse testing |
| API/worker → PostgreSQL | Parameter binding, tenant context, RLS, composite ownership keys, hardened runtime grants | Real production role/ownership query, connection transport proof, cross-tenant test |
| API/worker → raw storage | Content-addressed SHA-256 reference; production storage topology validation; organization-prefixed S3 keys in the managed profile | Bucket/volume ACLs, encryption-at-rest proof, versioning/backup/restore evidence; VPS filesystem keys are not tenant-prefixed |
| Worker → providers | Provider adapters, server-side secrets, timeouts, closed output schema, evidence/review gates | Restricted keys, quotas/cost alarms, egress policy, region/DPA approval |
| Source → runtime image | Locked dependencies, digest-pinned base images, CI audits and Hostinger Trivy scans | SBOM, image signature/provenance, registry policy, runtime digest inspection |

## Fail-closed production configuration

For `LABELSCAN_ENV=production`, the API or worker refuses to start when its required
contract is missing.

Shared checks include:

- the resolved topology is exactly `managed` or `single-vps`; an unset topology resolves
  to `managed`;
- header authentication is disabled;
- the database URL and selected raw-store settings are present;
- managed database transport uses `sslmode=verify-full`;
- managed storage is S3 with `aws:kms`, a key ID, bucket, and region;
- single-VPS storage is the filesystem path `/app/data/raw`, and the database host is
  exactly `db` on the standard PostgreSQL port.

The API additionally requires a non-placeholder JWT secret of at least 32 bytes, explicit
issuer/audience, release version, HTTPS public origin, explicit hosts, and exact IPs or
private proxy CIDRs. The worker requires the Google OCR selection and both provider keys.

The runtime can read a secret from `NAME` or `NAME_FILE`, but rejects both at once and
limits secret files to 64 KiB. The production Compose profiles use mounted files. Direct
environment values remain supported by code, so an operator must verify that the chosen
deployment does not expose them through process or container metadata.

## Authentication and sessions

- Access tokens use HS256 and include `jti`, session family (`sid`), issuer, audience,
  actor, organization, role, scopes, stores, business portals, profession, and client
  type. Their default lifetime is 15 minutes and configuration cannot extend it beyond
  one hour.
- Refresh tokens are opaque random values. Only their SHA-256 digests are stored in
  PostgreSQL. The default lifetime is seven days and the configured maximum is 30 days.
- Refresh rotates atomically. Reuse of a consumed token revokes its session family.
- Every protected production request checks that the session family behind the JWT is
  still active.
- Browser refresh tokens use an `HttpOnly`, `SameSite=Strict` cookie, marked `Secure` in
  production and restricted to `/v1/auth`. Browser access tokens live in application
  memory.
- Mobile login/refresh returns both tokens in the JSON response. The intended mobile store
  is SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
- Production browser login, refresh, and logout require the exact configured `Origin`.
  Mobile uses token bodies rather than the browser cookie flow.
- Login uses a dummy PBKDF2 verification for unknown accounts and a generic error to
  reduce username enumeration.

The rate limiter is in memory. Defaults bound failed logins by IP, add an account cooldown,
limit refresh work, authenticated mutations, ingestion bursts, and long-poll holds. These
limits reset on process restart and do not coordinate across API processes.

### Mobile token storage

SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is the sole persistent token store.
Catalogue objects and exports contain no authorization metadata. The image hook derives
the current Bearer in volatile state, reacts to token rotation, and refuses any URL that
is not below the configured API base URL.

### Shared-device and offline-queue controls

Catalogue query keys and offline queues are partitioned by organization, actor, portal,
and trade. Hydration/replay starts only after the authenticated context is known; logout,
revocation, and scope changes clear the old perimeter first. Ownerless legacy rows are
quarantined rather than upgraded implicitly.

The versioned local schemas require organization and actor ownership. Ownerless legacy
rows are quarantined, and a session-generation guard prevents work started by one session
from continuing after a logout, revocation, or scope change. An `in_flight` operation still
has no persisted lease recovery, and visible scan-card persistence is not atomic with
durable photo/outbox persistence. Those remaining reliability gaps can strand or hide work
after a crash.

JSON and CSV exports use an allow-listed, credential-free DTO and a temporary cache file
deleted in `finally` after success, cancellation, or error. Startup ageing removes files
left by an interrupted process. See OR-01 through OR-07 in the
[risk register](THREAT-MODEL.md#confirmed-open-risk-register).

## Authorization and tenant isolation

The active roles are `super_admin`, `admin`, and `manager`.

| Role | Current boundary |
|---|---|
| `super_admin` | All stores and portals in its organization; only role that manages administrators |
| `admin` | Stores/portals owned by that administrator; manages their managers and configuration |
| `manager` | One active business portal and the store/profession derived from it; only role accepted by mobile |

`super_admin` is organization-wide, never platform-global. The historical `operator` value
remains interpretable in old data but production authentication does not accept it.

Authorization combines:

1. verified identity and active session;
2. required capability/scope;
3. organization, store, and business-portal context;
4. parameterized repository predicates;
5. PostgreSQL RLS and composite foreign keys;
6. immutable ownership snapshots on historical ingestion/traceability rows.

Privileged identity operations re-read the actor's persisted role and assignments. Role,
password, assignment, account, store, or portal changes revoke affected sessions. A hidden
or foreign record is generally returned as `404`; `403` is used for a known action denied
by role/scope or an explicit out-of-assignment request.

## Password policy

The server is authoritative:

- all new passwords are 12–128 characters and known placeholders are rejected;
- administrator and super-administrator passwords must also contain uppercase,
  lowercase, digit, and non-alphanumeric characters;
- manager passwords use the length and placeholder policy;
- password hashes use PBKDF2-HMAC-SHA256 with a per-password random salt and 600,000
  iterations; verification uses a constant-time comparison;
- changing a password requires the current password and revokes sessions.

Back-office forms mirror these rules, including the 12-character minimum and Unicode-safe
letter/number/special-character checks for privileged roles. The server remains
authoritative, and release tests cover each create/change flow so later UI drift cannot
weaken or misrepresent the policy.

PBKDF2 at this work factor is not recorded as a current vulnerability. The
[OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
prefers Argon2id for general password storage and lists PBKDF2-HMAC-SHA256 at 600,000
iterations when FIPS-140 compliance is required. The current encoding has no
rehash-on-login path or pepper. Benchmark Argon2id on the production hardware, add an
algorithm-versioned migration, and make any pepper decision together with key custody and
recovery design. This is hardening item OR-13, not a release blocker by itself.

## Upload and extraction boundary

The public ingestion route requires authentication, the ingestion scope, and an
idempotency key. It reads the upload incrementally, accepts JPEG/PNG/WebP only, limits the
file to 10 MiB, checks format headers and dimensions, caps either side at 10,000 pixels,
and caps total pixels. Hostinger Caddy rejects an 11 MiB multipart envelope before the API.

These checks are targeted parsers, not a complete image decode, malware scan, antivirus,
or content-disarm pipeline. Fuzz malformed, polyglot, truncated, and resource-intensive
files during security testing.

OCR and label text are treated as untrusted data. Provider output must match a closed JSON
schema and exact profile field set. The domain evidence gate rejects unsupported values,
confidence/profile rules route uncertainty to review, and GS1 values take precedence for
the fields they encode. These controls reduce prompt-injection and fabrication risk; they
do not prove model correctness. Adversarial evaluation and human review remain required.

The persisted provider history is deliberately described more narrowly than the accepted
ADR-0003 target. The extraction consumer stores a reduced OCR projection (full text, mean
confidence, and page) and a reduced LLM projection (decoded fields plus model/prompt
metadata). It does not preserve the complete provider envelopes, OCR geometry, or
per-token confidence. OR-17 tracks the immutable, access-controlled provider-artifact
design and retrieval proof needed to close that evidence gap.

## Database and audit controls

- Tenant-owned tables use organization context and RLS where defined by migrations.
- The current hardening migration forces RLS on protected ingestion and related tables and
  fails if `labelscan_app` is privileged, owns protected objects, or is used to migrate.
- The runtime role has explicit table/function grants and cannot create database objects,
  use privileged role membership, or bypass RLS in the single-VPS contract.
- Raw artifacts, extraction history, audit rows, batches, and other historical tables use
  restricted grants and mutation-denial triggers where their migrations define them.
- Audit triggers run as a tightly scoped definer function and require transaction-local
  actor/action/correlation/trace context. The business write and audit row commit or roll
  back together.
- Mutable operational tables such as sessions, outbox delivery, ingestion status, alerts,
  assignments, and current projections are not described as append-only.

The audit row contains event time, actor, action, subject schema/table/ID, correlation ID,
and trace ID. It does not contain the before/after snapshot references specified by
ADR-0004. The journal proves that a configured write occurred with its security context,
but it cannot by itself reconstruct the old and new values. OR-18 tracks a secret-safe
snapshot or immutable change-record design and its same-transaction tests.

Database controls still depend on the connection role actually used. Tests with a
superuser cannot prove the production runtime boundary; inspect the live role, memberships,
object ownership, grants, `rolbypassrls`, and RLS behavior.

Managed S3 keys include the organization prefix. The filesystem raw store used by the
single-VPS profile ignores `organization_id` when it derives a path and stores bytes only
by content hash. Normal API and database authorization still scopes access, but the
volume is not a storage-level tenant boundary: a compromised process or known checksum
can cross that defense-in-depth layer. Treat OR-11 in the
[open-risk register](THREAT-MODEL.md#confirmed-open-risk-register) as a deliberate VPS
storage migration decision, not as equivalent to managed S3 isolation.

The S3 adapter recomputes SHA-256 after a read. The filesystem store and its HTTP image
reader do not; they trust the checksum-derived path. The database still records the expected
hash, but corruption or unauthorized byte changes are not detected on the VPS read path.
OR-15 requires fail-closed read verification plus operational durability checks.

## HTTP and browser controls

Production disables `/docs`, `/redoc`, and `/openapi.json`. API responses default to
`Cache-Control: no-store`, use sanitized RFC 9457 problem responses, and return correlation
IDs without internal exception details. Security middleware adds content sniffing, frame,
permissions, referrer, and CSP controls. The back office receives a same-origin CSP; public
Hostinger responses receive canonical HSTS, content-type, and referrer headers from Caddy.

Caddy rejects unknown HTTP hosts and uses strict SNI handling for HTTPS. The Hostinger API
trusts the private `172.16.0.0/12` proxy CIDR configured in Compose, so Docker network
membership is part of the trust boundary. The deploy smoke test covers unknown hosts and
forged identity headers, but it does not replace a full forwarded-header test from every
network position.

## Container and supply-chain controls

Application and worker containers run as UID/GID `10001` with a read-only root filesystem,
a bounded `noexec,nosuid,nodev` temporary filesystem, all capabilities dropped,
`no-new-privileges`, and resource/PID limits. Caddy runs as UID/GID `10002` and retains
only `NET_BIND_SERVICE`. PostgreSQL runs as its non-root image user on a writable private
data volume; it cannot use the application read-only profile.

Base images and GitHub Actions are pinned. Python requirements are fully resolved and
hashed; npm lockfiles are audited. CI performs a high-signal tracked-secret scan. The
Hostinger release gate scans all three runtime images and deployment configuration with
Trivy.

The tracked-secret scan recognizes selected key patterns and filenames; it is not a full
secret detector. The VPS workflow does not currently generate an SBOM or sign its locally
built images. Runtime image provenance and registry enforcement remain external for the
managed profile.

## Mobile transport controls and limitation

The intended production/preview EAS profiles use HTTPS and configure Android API 33 as the
minimum, disable Android backups, block unnecessary sensitive permissions, and enable
release shrinking/minification. The static Android check resolves the configuration as a
production profile.

A locally assembled Android release can retain cleartext traffic when
`LABELSCAN_BUILD_PROFILE` is not `preview` or `production`. Therefore the static check
alone does not prove the shipped native artifact. The release process must use an approved
profile and inspect the generated manifest/network security configuration before approval.

## Controls that are not implemented here

Several enterprise controls sit outside the current repository: SSO/OIDC, MFA,
MDM/kiosk policy, remote device attestation, automatic malware scanning/content disarm,
a distributed rate limiter, Prometheus/OpenTelemetry, automatic SLO alerting, and a tested
incident-response platform.

Implemented areas also have unresolved gaps. The
[open-risk register](THREAT-MODEL.md#confirmed-open-risk-register) is the only maintained
source for their priority, impact, remediation, and exception policy:

- mobile credentials, account isolation, queued work, durability, exports, Android
  transport, and local capacity: `OR-01`–`OR-07`, `OR-16`, `OR-19`;
- deployment credentials, egress, backups, storage tenancy, and filesystem integrity:
  `OR-08`–`OR-11`, `OR-15`;
- operational detection, provider evidence, and audit reconstruction: `OR-12`, `OR-17`,
  `OR-18`;
- password evolution/forms, model compatibility, and client-header ownership: `OR-13`,
  `OR-14`, `OR-20`, `OR-21`.

These gaps are not implied acceptance. Do not approve a P0 item as ordinary technical
debt.
