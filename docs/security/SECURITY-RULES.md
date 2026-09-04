# Production security rules

These rules are release gates. A repository test can prove that code contains a control;
only environment evidence can prove that production is using it. The detailed rationale
is in the [security architecture](SECURITY-ARCHITECTURE.md), and evidence belongs in the
[pre-pentest checklist](PRE-PENTEST-CHECKLIST.md).
The [confirmed open-risk register](THREAT-MODEL.md#confirmed-open-risk-register) is the
single source for priority, release-blocker status, impact, and required remediation.

## Network and HTTP

- Only the approved TLS edge may be public. API, PostgreSQL, workers, raw storage, and
  Docker management interfaces must remain private.
- HTTP must redirect to HTTPS, unknown hosts must be rejected, certificates must renew
  safely, and public HSTS/security headers must be verified from outside the platform.
- Production must explicitly configure its public origin, accepted hosts, and trusted
  proxy addresses. Untrusted peers must not be able to select their own client IP with
  forwarded headers.
- `/docs`, `/redoc`, and `/openapi.json` must return `404`. Production readiness must not
  name the failed internal dependency.
- The edge envelope and API file limits must both be tested. On the Hostinger profile,
  Caddy allows an 11 MiB multipart envelope and the API allows a 10 MiB image file.
- Worker egress must be restricted to required destinations. The VPS `egress` network
  alone does not provide that restriction.

## Authentication and sessions

- Business routes require a valid signed JWT and an active server-side session. Header
  identity is forbidden in production.
- Access tokens must remain short-lived. Refresh tokens must be opaque, hashed at rest,
  rotated atomically, and replay-tested.
- Browser refresh cookies must remain `HttpOnly`, `Secure`, `SameSite=Strict`, and limited
  to `/v1/auth`. Browser auth mutations must require the exact public origin.
- Mobile login is limited to an active manager with exactly one portal. Browser and mobile
  refresh tokens must not cross client types.
- Login, refresh, ingestion, mutation, and long-poll limits must be exercised under the
  real topology. More than one API process is forbidden until the process-local controls
  are replaced or complemented by a shared/edge limiter.
- Password, role, assignment, account, store, and portal changes must revoke affected
  sessions. Incident response must be able to revoke a whole session family.
- The server's salted PBKDF2-HMAC-SHA256 implementation uses 600,000 iterations and
  constant-time verification. Argon2id benchmarking, algorithm-versioned rehash on login,
  and an optional pepper are hardening work, not a claimed current vulnerability.

## Authorization and tenant isolation

- Capability and data perimeter are separate checks. A scope must never widen the signed
  organization/store/portal boundary.
- `super_admin` is organization-wide, never platform-global. Administrators are limited to
  stores/portals they own. Managers are limited to one active portal.
- Privileged identity changes must re-read persisted role and assignment data.
- Repository queries must use bound parameters and explicit organization/store/portal
  predicates. PostgreSQL RLS and composite ownership keys are required as defense in
  depth.
- Hidden or foreign IDs must not leak existence through response status or detail.
- Cross-tenant tests must run with the actual restricted production role, not only with a
  migration owner or test superuser.

## Data, audit, and migrations

- The original image must be stored before an ingestion is acknowledged. Its SHA-256,
  organization, and storage reference must remain linked to the immutable database
  artifact.
- Managed S3 keys are organization-prefixed. The single-VPS filesystem store is keyed only
  by content hash, so API/DB authorization—not the volume layout—provides tenant isolation.
  Do not present the two storage boundaries as equivalent.
- Historical tables are append-only only where migrations enforce restricted grants and
  mutation-denial triggers. Mutable sessions, outbox state, ingestion status, alerts,
  assignments, and current projections must not be mislabeled as immutable.
- Every audited business write must set actor, action, correlation, and trace context in
  the same transaction. Missing context or audit failure must roll back the write.
- An audited mutable change must retain or reference a secret-safe record of the values
  before and after the operation. The current audit table does not satisfy this rule;
  OR-18 remains open until authorized reconstruction and same-transaction tests pass.
- Migration credentials must be separate from the API/worker runtime connection. The
  single-VPS profile meets this rule; the current managed Compose profile does not and is
  blocked until its secret contract changes.
- Backups must include PostgreSQL and matching raw-image data. A backup on the production
  VPS is not sufficient disaster recovery; keep an encrypted off-host copy and prove a
  restore.
- Automatic image rollback must never be described as database rollback. Migrations must
  remain compatible with the previous release throughout the rollback window.

## Uploads and AI extraction

- The public API accepts only authenticated JPEG/PNG/WebP uploads with a required
  idempotency key, bounded file size, valid format header, and bounded dimensions.
- Transport validation is not malware detection. Fuzz malformed/polyglot inputs and add a
  scanning/content-disarm control if the risk assessment requires one.
- OCR text and label content are untrusted data, never instructions. Provider output must
  match the closed schema and exact trade profile before persistence.
- A machine-extracted non-null value must remain tied to evidence and confidence.
  Unsupported or uncertain values must stay null or go to human review.
- Complete, bounded OCR/LLM provider responses needed for audit and reprocessing must be
  stored as immutable, checksum-protected, access-controlled artifacts. Reduced normalized
  projections are not equivalent; the current implementation remains open as OR-17.
- GS1 reconciliation, provider timeouts/retries, prompt-injection tests, quota/cost limits,
  and model-quality calibration must be verified before relying on automatic extraction.
- Raw images, OCR text, prompts, provider payloads, and secrets must not appear in
  application logs.

## Secrets and containers

- No secret may enter Git, an image layer, a browser bundle, a mobile
  `EXPO_PUBLIC_*` value, a log, a screenshot, a ticket, or a shared command history.
- Secrets must be mounted only into their consumer: runtime DB/JWT for API, runtime DB and
  provider keys for workers, and owner DB credentials for migrations/approved maintenance.
- Application and worker containers must run non-root with read-only roots, dropped
  capabilities, `no-new-privileges`, bounded resources, and no Docker socket.
- Caddy may retain only the bind-service capability. PostgreSQL needs a writable data
  volume but must stay non-root and private.
- Dependency audits, secret scanning, image/configuration scanning, immutable release
  identity, SBOM, and image provenance must match the release policy. The Hostinger
  workflow currently lacks SBOM generation and image signing.

## Mobile and web regression gates

- Catalogue DTOs and exports must never contain authorization headers. Image Bearers
  are created only in volatile state and only for the configured backend origin.
- Ownerless legacy operations are quarantined; every new offline operation carries
  organization, actor, portal, and trade ownership.
- Catalogue and offline keys remain identity-partitioned, and logout/revocation/scope
  changes purge them before another session can hydrate or replay work.
- Mobile `in_flight` operations have no lease or stale-claim recovery. Process-kill tests
  must pass before claiming crash-safe offline replay.
- Durable photo/outbox work and its visible scan card are not persisted atomically. Startup
  reconciliation or a single durable journal must pass kill tests before claiming that
  pending work cannot become hidden.
- A failed pending-photo copy currently falls back to a temporary URI and still enqueues.
  Production capture must either prove a durable copy or fail visibly before creating work.
- JSON/CSV exports use credential-free allow-listed models. Temporary files are cleaned
  on success, cancellation, and error, and stale interrupted exports are aged at startup.
- A local Android release can keep cleartext enabled unless the approved preview/production
  profile is selected. Inspect the generated native artifact; the static configuration
  check is not sufficient proof.
- Back-office forms mirror the role-specific password policy: managers have no displayed
  minimum or complexity rule, while privileged accounts require at least 12 characters
  with Unicode-safe letter/number handling. The API remains authoritative and release
  tests cover each role.

## Production approval

A release is blocked when any required repository gate fails, any external control lacks
release-specific evidence, or a blocker in the
[open-risk register](THREAT-MODEL.md#confirmed-open-risk-register) has neither remediation
nor an explicit time-bounded exception from the responsible owners. A passing Compose
render or public smoke test is necessary evidence, not a security certification.
