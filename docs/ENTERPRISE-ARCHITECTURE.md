# LabelScan enterprise architecture

This document gives a current, system-level view of LabelScan: what runs, how data moves,
where trust boundaries sit, and which guarantees still depend on external operations. It
is an orientation guide, not a legal compliance statement or a substitute for the
executable configuration.

For implementation details, continue with the
[backend architecture](backend/BACKEND-ARCHITECTURE.md),
[database reference](database/DATABASE.md), and
[security architecture](security/SECURITY-ARCHITECTURE.md). The
[architecture decisions](architecture/adr/README.md) preserve why the main choices were
made. The [open-risk register](security/THREAT-MODEL.md#confirmed-open-risk-register) is
the single prioritized source for confirmed blockers and hardening work.

## Product surfaces

| Surface | Primary users | Responsibility |
|---|---|---|
| Expo mobile app | Store managers working at receiving | Capture a label, queue uploads, guide review, and cache the authorized catalogue |
| React back office | Managers, administrators, and super-administrators | Browse arrivals and administer the stores, portals, and accounts allowed by the current role |
| FastAPI API | Mobile and browser clients | Authenticate sessions, validate requests, persist captures, expose review/catalogue operations, and serve the built back office |
| Background worker | Internal only | Relay outbox events, call optical character recognition (OCR) and large language model (LLM) providers, apply extraction gates, and build traceability/Hazard Analysis and Critical Control Points (HACCP) projections |
| PostgreSQL | API, workers, and migrations | Store identity, ingestion, extraction, traceability, HACCP, audit, outbox, and current projections |
| Raw-image storage | API and workers | Keep the original label bytes outside PostgreSQL, addressed by their SHA-256 checksum |

The current business profiles are fishmonger (`poissonnerie`), butcher (`boucherie`), and
prepared-food/catering (`charcuterie_traiteur`). The combined prepared-food/catering code
is one profession and one ownership boundary.

## Architectural shape

LabelScan is a modular monolith with separate API and worker processes built from the same
backend image.

```text
Expo mobile ── HTTPS/JWT ──┐
                           ├── FastAPI API ── PostgreSQL
React back office ─────────┘          │             │
                                     │       transactional outbox
                              raw-image store       │
                                                    ▼
                                                  worker
                                             ┌──────┴──────┐
                                      Google Vision     Anthropic
```

The backend contains six bounded contexts: `identity`, `ingestion`, `traceability`,
`haccp`, `compliance`, and `audit`. Each context follows the inward dependency direction
`adapters → application → domain`. Import Linter checks that contexts do not import one
another. Domain modules remain independent of infrastructure; application modules stay
independent of database and provider adapters but use a shared access-context type for
authorization boundaries.

Cross-context work uses IDs and PostgreSQL outbox events. The relay provides at-least-once
delivery, row claiming with `FOR UPDATE SKIP LOCKED`, per-consumer deduplication, bounded
retry, and a dead-letter state. This is not an external message broker: PostgreSQL remains
the coordination point.

## Capture-to-catalogue flow

1. A manager signs in on an authorized surface. Mobile access requires one active business
   portal and its derived store/profession.
2. `POST /v1/ingestions` validates the idempotency key, media type, image header,
   dimensions, and 10 MiB file limit.
3. The server writes the original image to the selected raw store first. It then commits
   the ingestion row, immutable artifact reference, audit entry, and `ingestion.raw_stored`
   outbox event. HTTP `202` is returned only after that work succeeds.
4. A worker parses any GS1 barcode data, calls Google Vision, applies the OCR-quality gate,
   and asks Anthropic for the closed structured field set.
5. Boundary, evidence, and confidence checks keep unsupported values null. The worker then
   reconciles accepted model fields with GS1 source precedence and routes uncertain or
   incomplete results to human review. Normalized provider projections and extraction runs
   are retained as immutable evidence; verbatim provider envelopes are not.
6. A review creates a new reviewed run and publishes `review.finalized` in the same
   transaction. Traceability consumers update the current arrival projection without
   rewriting the earlier extraction history.
7. Mobile and web read the authorized catalogue projection. Historical records keep
   snapshots of organization, store, business portal, profession/profile, and actor so a
   later access change does not move old data.

An object-store write can succeed before the database transaction fails. In that case the
content-addressed object may temporarily be orphaned, but no `202` has been returned and a
retry with the same idempotency key/checksum is safe. Operational cleanup must never remove
an object that is still referenced by PostgreSQL.

## Identity and ownership

A business portal is the unique combination of organization, store, and profession. Role
capability and data perimeter are separate checks.

| Role | Surface | Current data perimeter |
|---|---|---|
| `super_admin` | Browser | Organization-wide; can manage administrators and inherits administrator capabilities |
| `admin` | Browser | Stores and portals owned by that administrator; can manage their managers and store configuration |
| `manager` | Browser and mobile | Exactly one active portal assignment and its derived store/profession |

Every production access token includes the organization, role, stores, portals, client
type, session family, issuer, and audience. Protected requests validate the signature,
expiry, expected issuer/audience, and active server-side session. Privileged identity
writes also re-read persisted role and assignment data. Assignment, role, password, and
activation changes revoke affected sessions so stale tokens cannot be refreshed normally.

Repository predicates and PostgreSQL row-level security (RLS) provide a second organization
boundary. Store and portal filters narrow that organization scope. Hidden or foreign
resource IDs are generally returned as `404` to reduce enumeration; a known action denied
by role/scope returns `403`.

## Data and audit model

PostgreSQL is the source of truth for business state and metadata. Raw-image storage is
the source of truth for original bytes; the database keeps their content checksum and
storage reference.

The two raw-storage implementations do not provide the same defense in depth. Managed S3
keys are organization-prefixed. The filesystem store used on the single VPS derives paths
only from the content hash and ignores `organization_id`. API and database authorization
still protect normal reads, but the volume layout is not itself a tenant boundary.

The model distinguishes historical facts from working state:

- raw artifacts, extraction runs, extracted fields, reviewed history, audit rows,
  temperature readings, batches, and versioned control plans are append-only where the
  migrations define that guarantee;
- sessions, outbox delivery state, ingestion status, alerts, identity assignments, and
  current arrival projections are intentionally mutable;
- database grants and triggers enforce immutable tables and same-transaction audit where
  configured;
- the runtime database role is expected to be non-owner, non-superuser, and unable to
  bypass RLS. The single-VPS deployment enforces a separate migration owner; the managed
  Compose profile does not yet provide separate database secrets.

Confidence and provenance live with each extracted field. A value can come from GS1, OCR,
LLM, or human review, but a non-null machine-extracted value must remain tied to evidence.
That history is not a verbatim provider archive. The current OCR projection keeps full
text, mean confidence, and a page number; the LLM projection keeps decoded fields and
model/prompt metadata. Complete provider envelopes, OCR geometry, and per-token confidence
are not retained, so the provider-response portion of ADR-0003 remains only partially
implemented.

Audit rows currently record time, actor, action, subject, correlation ID, and trace ID.
They do not contain or reference before/after snapshots, so the append-only journal cannot
by itself reconstruct the exact values changed in a mutable record. This is the remaining
gap in ADR-0004.

The current rule set is built from versioned trade profiles; the code still labels this as
a placeholder compliance rule set. Product or legal owners must approve regulatory field
requirements before treating them as compliance policy.

## Production topologies

### Managed services

The managed profile runs the API, worker, and one-shot migration job. PostgreSQL,
S3-compatible storage, the Transport Layer Security (TLS) edge, secret objects, networks,
backups, and monitoring are
external. Production startup requires `sslmode=verify-full`, an HTTPS public origin,
explicit hosts/proxies, S3 with Key Management Service (KMS) settings, and provider secrets.

The repository does not deploy this topology. Its current Compose file also shares one
database secret between migrations and runtime, so the documented least-privilege
owner/runtime split is not implemented there yet. See the
[deployment guide](../deploy/README.md) before using it.

### Hostinger single VPS

The Hostinger profile runs Caddy, PostgreSQL, API, workers, and filesystem raw storage on
one host. Only Caddy publishes ports. The database network is internal and raw bytes live
in a private Docker volume. The release script separates database owner/runtime
credentials, creates local pre-release database/image backups, applies migrations, starts
one API with two workers, and runs public smoke checks.

This topology has a larger failure domain: the application, database, raw images, and
local release backups share one VPS. Off-host encrypted backup and tested restore are
therefore mandatory external controls. Its worker egress network is not a destination
allow-list.

## Currently available operational signals

- `/v1/health/live` confirms that the API process can answer HTTP.
- `/v1/health/ready` checks PostgreSQL and the selected raw store. Production responses do
  not identify which dependency failed.
- `/v1/version` reports the injected release identity and active rule-set version.
- the worker maintains a heartbeat file used by its container health check;
- application and worker logs are JSON with an allow-listed set of correlation, tenant,
  outcome, retry, and latency fields;
- outbox retry/dead-letter state is queryable in PostgreSQL.

Prometheus metrics, OpenTelemetry spans, automatic service-level objective (SLO)
calculation, centralized alerting,
and a continuous audit/durability verifier are not implemented in this repository. They
must not be described as live controls until an environment provides and tests them. See
the [SRE guide](operations/SRE-RELIABILITY.md) for the current operating baseline.

## Known architecture gaps

The [open-risk register](security/THREAT-MODEL.md#confirmed-open-risk-register) is the
canonical source for priority, impact, remediation, and closure evidence. At architecture
level, the unresolved work groups into four areas:

- **Mobile identity and local state:** credential-bearing catalogue data, cross-account
  cache hydration, incomplete queued-work ownership, interrupted operations, local
  durability, exports, and storage capacity (`OR-01`–`OR-07`, `OR-16`, `OR-19`).
- **Production topology:** the managed database credential split, VPS egress and backup
  isolation, storage tenancy, and filesystem integrity (`OR-08`–`OR-11`, `OR-15`).
- **Detection and evidence:** operational visibility, retained provider evidence, and
  before/after audit reconstruction (`OR-12`, `OR-17`, `OR-18`).
- **Identity, provider, and client hardening:** password evolution and form consistency,
  model-feature compatibility, and reserved request headers (`OR-13`, `OR-14`, `OR-20`,
  `OR-21`).

The release-blocking items are `OR-01`, `OR-02`, `OR-03`, `OR-06`, `OR-08`, and `OR-16`.
SSO/OIDC, MFA, managed-device policy, content disarm, distributed tracing, and
repository-managed incident paging are also not implemented. Use the
[security checklists](security/PRE-PENTEST-CHECKLIST.md) to collect release-specific
evidence; do not treat this summary as risk acceptance.
