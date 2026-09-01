# LabelScan backend architecture

This document describes the backend that exists in `server/`: its runtime
processes, module boundaries, main workflows, data guarantees, security model,
and current limitations. It intentionally avoids roadmap endpoints and legal
interpretation.

For transport details, use [`API-CONTRACTS.md`](./API-CONTRACTS.md) and the
generated [`openapi.v1.yaml`](./openapi.v1.yaml). For storage details, use
[`DATABASE.md`](../database/DATABASE.md).

## What the backend does

LabelScan accepts photos of food labels for three business portals:
`poissonnerie`, `boucherie`, and `charcuterie_traiteur`. It preserves the source
image, extracts a versioned field set, routes uncertain results to human review,
and publishes a searchable arrival only after a complete review is finalized.

The design focuses on four practical guarantees:

1. The source image is stored before the API acknowledges the capture.
2. OCR and model proposals are not accepted without deterministic validation.
3. Machine runs and human revisions are append-only.
4. Organization, store, portal, profile, and capture actor are snapshotted so
   later account changes do not rewrite historical ownership.

These are engineering guarantees. They do not, by themselves, certify legal or
regulatory compliance. The current required-field rules are application profile
defaults and still need an authoritative compliance owner.

## Runtime topology

```text
Mobile app / back office
          |
          | HTTPS + bearer access token
          v
  FastAPI application --------------> private object store
          |                                 ^
          | PostgreSQL writes               | image / OCR / model artifacts
          v                                 |
      PostgreSQL <-------------------- outbox worker(s)
          |
          +---- identity, ingestion, traceability, alerts, audit
                                      |
                                      +--> Google Vision OCR
                                      +--> Anthropic Claude
```

The deployment has three long-running responsibilities:

| Responsibility | Entrypoint | What it does |
|---|---|---|
| HTTP API | `labelscan.app.http_app:create_app` | Authentication, authorization, durable submission, review writes, and read models |
| Outbox worker | `python -m labelscan.app.worker_runtime` | OCR, extraction, event delivery, traceability registration, and alert creation |
| PostgreSQL | PostgreSQL 16 | Source of truth, tenant enforcement, audit triggers, outbox, and projections |

Migration and demo seeding are one-shot jobs, not application processes. The API
never calls OCR or the LLM. If workers stop, already accepted captures remain in
the database and object store, but their extraction does not progress.

`FOR UPDATE SKIP LOCKED` prevents multiple workers from claiming the same database
row concurrently. Horizontal scaling still requires provider-capacity planning and
provider-side idempotency for effects outside the transaction. Each worker writes its
own heartbeat file for its container health check; there is no worker HTTP endpoint.

## Code organization

```text
server/src/labelscan/
├── app/                 composition roots for API and worker processes
├── business_profiles.py active and historical extraction profiles
├── contexts/
│   ├── identity/        accounts, sessions, stores, portals, and access rules
│   ├── ingestion/       capture, OCR/LLM orchestration, review, and provenance
│   ├── traceability/    batches and the arrivals projection
│   ├── haccp/           control checks and alert lifecycle
│   ├── compliance/      reserved boundary; no authoritative rule store yet
│   └── audit/           reserved boundary; database triggers own current writes
└── platform/            database, object storage, HTTP middleware, outbox, logging
```

Each active context follows the inward dependency direction
`adapters → application → domain`. Domain modules use only the standard library
and local domain types. Contexts do not import one another; integration happens
through IDs and outbox events. These boundaries are checked by the
import-linter configuration in `server/.importlinter`.

The `app` package is the composition root. It is the only layer that knows which
concrete providers and event consumers should be wired together.

## Capture workflow

### Request boundary

`POST /v1/ingestions` requires `ingestion:write`, a safe `Idempotency-Key`, and
a valid JPEG, PNG, or WebP image no larger than 10 MiB. The transport validates
the actual image bytes, not only the declared content type. Barcode text and the
client timestamp are optional; the timestamp must include a timezone and is
stored as a client claim rather than an authoritative event time.

### Durable acceptance

The submit use case performs this sequence:

1. Calculate the image SHA-256.
2. Write the bytes to the configured content-addressed object store.
3. Start a database transaction and set tenant and audit context.
4. Claim the request idempotency scope.
5. Insert the ingestion, image artifact, and `ingestion.raw_stored` outbox event.
6. Commit, then return `202 Accepted`.

The business row, raw-artifact metadata, audit entries, idempotency result, and
outbox event commit together. The object write happens first, so a database
failure can leave an unreferenced content-addressed object; it cannot leave an
acknowledged ingestion without its image. There is currently no automatic orphan
object collector.

The same idempotency key with the same image replays the original ingestion. The
same key with different bytes is a conflict. Internal callers without a key fall
back to content-hash identity.

## Extraction workflow

The worker handles `ingestion.raw_stored` asynchronously:

```text
native barcode ──> GS1 parser ───────────────────────────────┐
                                                            |
image ──> OCR ──> quality gate ──> interim preview ──> LLM ──┤
                                                            v
                                                 validation + reconciliation
                                                            |
                                                            v
                                             append run, fields, and status
```

### Deterministic barcode path

The pure GS1 parser reads the native scanner payload, not OCR text. It supports
the subset used by the application: GTIN, lot, relevant dates, and net weight.
Malformed or unsupported elements produce warnings instead of guessed values.

Scanner-derived values take precedence over model values for `batch_number`,
`expiry_date`, `packaging_date`, `weight`, and `gtin`. A printed-versus-barcode
conflict on lot or expiry forces review. A reviewer can later replace one of
these fields only with the explicit `force_gs1` acknowledgement.

### OCR path

The configured production adapter is Google Vision. It sends the original image
to `DOCUMENT_TEXT_DETECTION` by default, with French and English language hints.
`TEXT_DETECTION` is an explicit alternative and must be evaluated on representative
labels before rollout.

The adapter has a bounded request timeout. Provider responses are size-checked,
normalized, stored in the private object store, and referenced by append-only
artifact metadata. A committed artifact prevents another provider call on a
normal retry.

This is deduplication, not a strict external exactly-once guarantee: a process
can crash after a provider accepted a request but before the artifact commits,
in which case the next delivery may call the provider again.

### OCR quality and interim fields

Clearly unusable OCR can bypass the LLM. The worker still stores the OCR result,
preserves any GS1 fields, appends a `needs_review` run, and exposes ingestion
status `ocr_skipped_garbage`.

For usable OCR, a best-effort intermediate transaction sets `ocr_done` and may
store conservative regex matches for lot, expiry, packaging date, and storage
temperature. These fields are a preview only. They never feed validation,
traceability, or alerts and disappear from the read model once a real run exists.

### Model extraction

The Claude adapter builds a structured-output schema from the ingestion’s
snapshotted trade profile. New ingestions use profile version 2; version 1 remains
resolvable for immutable historical workflows. The default model is
`claude-haiku-4-5`, configurable through `LABELSCAN_LLM_MODEL`.

Optional escalation uses a second configured model only when a required
free-text field remains missing or weak after the first validation pass. It is
off by default. Barcode-owned fields are never escalation candidates. Any
escalated output passes through the same validation gate.

The primary Poissonnerie system prompt has an explicit cache breakpoint when
prompt caching is enabled. Other trade prompts are compact and are not marked
for caching by the current adapter. OCR text and GS1 hints stay in the dynamic
user message.

### Validation gate

The pure domain gate enforces the acceptance invariants for machine proposals.
It does not prove semantic correctness or the truth of the source label. It:

- rejects unexpected and duplicate field names;
- rejects non-finite or out-of-range confidence values;
- requires every non-null LLM value to cite evidence found verbatim in OCR text;
- coerces proposals without OCR-backed evidence to null and records security flags;
- checks the controlled `production_method` vocabulary;
- checks that expiry does not precede packaging;
- combines confidence as the minimum of LLM and OCR confidence;
- sends missing or low-confidence required fields to review.

Default confidence bands are low below `0.70`, medium from `0.70`, and high from
`0.90`. These are configurable operational defaults, not validated regulatory
thresholds. Changing them should follow calibration on a labeled dataset and a
rule-set version change.

### Provider and worker failures

OCR and LLM calls each have a bounded in-consumer retry budget. Exhausting that
budget appends an `extraction_failed` run and consumes the event, so an expected
provider outage does not loop forever.

Unexpected handler exceptions roll back the event transaction. The outbox relay
then records the failure in a separate transaction, schedules equal-jitter
exponential backoff, and eventually marks the event `dead_letter`. The retry
limit is configurable. There is currently no HTTP or command-line DLQ inspection
and requeue interface.

## Human review and publication

Machine extraction never creates an arrival. Publication begins with the atomic
review endpoint:

```text
POST /v1/ingestions/{id}/reviews
        |
        | one transaction
        +--> append a complete human-sourced run
        +--> set ingestion to confirmed
        +--> store photo orientation
        +--> bind the idempotency key
        +--> enqueue review.finalized
                       |
                       v
             traceability registration
                       |
             batch.registered / batch.flagged
                       |
                       v
                   alerting
```

The submitted fields must exactly match the ingestion’s profile and every value
must be present. `NC` is an explicit human assertion that the label did not
communicate a value; it is not machine-generated.

The registration consumer accepts only confirmed ingestions whose complete run
is human-sourced. It deduplicates an already registered ingestion and repeated
physical lot identities. Consistency issues produce a flagged batch rather than
silent correction. A registered or flagged batch then updates the arrivals
projection and can create an alert.

The older per-field override and `/confirm` routes remain available. Overrides
append a copied run with one human change. `/confirm` records a review status but
does not emit the complete atomic publication event, so new clients should use
the `/reviews` operation.

## Data and integrity model

PostgreSQL is divided into schemas that mirror backend responsibilities:

| Schema | Main purpose |
|---|---|
| `identity` | Organizations, users, stores, portals, assignments, sessions |
| `ingestion` | Ingestions, artifacts, runs, fields, interim values, review idempotency |
| `traceability` | Products, suppliers, batches, current arrivals projection |
| `haccp` | Control plans, temperature records, alerts |
| `audit` | Append-only audit log |
| `platform` | Outbox, processed-event ledger, request idempotency, trigger functions |
| `compliance` | Reserved schema; no authoritative rule-set table is active |

Historical artifacts, extraction runs, extracted fields, registered business
records, and audit entries use database mutation-denial triggers. Mutable
lifecycle tables receive only the column privileges they need. Audit triggers
read transaction-local actor, action, correlation, and trace context and write in
the same transaction as the business change.

Tenant-owned tables use PostgreSQL row-level security. Direct tenant tables and
the ingestion child tables are forced through RLS, and repositories also add
explicit organization, store, and portal predicates. The runtime role is
separate from the migration owner and must not own application objects or carry
privileged role attributes.

Alembic migrations under `server/migrations/versions/` are the executable schema
history and the only deployment source of truth. The latest migration is always
addressed as Alembic `head`; documentation does not pin a revision number that
will immediately become stale.

## Security model

- Production accepts signed bearer tokens only. Header-based identity is a
  disabled local compatibility seam and production startup rejects it.
- Access tokens are short-lived and tied to an active server-side session family.
- Refresh tokens are opaque, hashed, rotated, client-type-bound, and revocable.
- Passwords use salted PBKDF2-HMAC-SHA256 and are never logged or returned.
- Roles grant capabilities; tenant, store, and portal assignments grant data
  perimeter. Both checks are required.
- Login, refresh, ingestion, general mutation, and long-poll abuse controls are
  process-local. A multi-replica API would need a shared limiter for global limits.
- Production validates HTTPS origin, allowed hosts, trusted proxies, database
  transport, object-store configuration, and required secrets at startup.
- Errors are sanitized for clients. Structured `extra` fields use an allow-list,
  and the logging policy forbids images, OCR text, model output, passwords, tokens,
  and provider keys. The formatter still includes message and exception text
  without a general redaction pass, so callers must sanitize those strings and
  retained secrets or personal data remain an operational risk.
- The application uses content-addressed object keys. It does not claim that the
  backing bucket has Object Lock or a separate retention policy unless deployment
  infrastructure explicitly configures those controls.

## Observability and operations

The API and worker emit JSON logs to standard output. Supported context includes
correlation and trace IDs, organization, ingestion and run IDs, outcomes,
provider timing, image size, cache token counters, escalation events, rate-limit
events, retry attempts, and DLQ scheduling.

This is structured logging, not a complete telemetry stack. The code does not
export Prometheus metrics or OpenTelemetry spans, define measured SLOs, or run a
drift monitor. Operators must derive dashboards and alerts in the deployment
platform or add those integrations explicitly.

Readiness checks the database and object store. It does not call Google Vision or
Claude and therefore cannot prove provider availability. Worker heartbeat only
proves that the poll loop is refreshing within its allowed age.

## Verification gates

Backend CI performs dependency audits, import-boundary checks, linting, OpenAPI
freshness checks, full migration upgrade/downgrade/upgrade, automated tests, a
production image build, and deployment Compose validation. The repository does
not publish a permanent test count because the suite changes with the code.

Use these source-backed checks when changing this architecture:

```bash
cd server
ruff check .
lint-imports
python scripts/export_openapi.py --check
alembic upgrade head
pytest
```

Migration reversibility requires a disposable database. Provider integration
tests require explicit credentials, network access, and budget; ordinary tests
use deterministic fakes.

## Known limitations and audit findings

- The active Poissonnerie required-field rule set is explicitly provisional;
  the repository has not assigned governance ownership or supplied an approved,
  authoritative versioned policy.
- `extraction.completed` is emitted after machine runs, but no consumer for that
  event type is registered. It does not publish an arrival and remains outside
  the worker’s claimable event types. This creates pending outbox rows that need a
  code-level cleanup or no-op consumption policy.
- Provider artifacts deduplicate committed work but cannot guarantee exactly-once
  billing across the crash window between a successful provider call and commit.
- The relay keeps the claimed outbox transaction open while the extraction handler
  performs OCR, LLM calls, and its side transactions. Slow providers therefore
  hold a database connection and row lock for the duration of the attempt.
- The raw object is written before the database transaction; failed submissions
  can leave unreferenced objects and there is no garbage collector.
- There is no operator-facing DLQ inspection or requeue workflow.
- Rate limiting is in process memory and is not coordinated across API replicas.
- Readiness does not cover OCR or LLM availability.
- Metrics export, distributed tracing export, drift detection, and measured SLOs
  are not implemented.
- The compact non-seafood prompts and the detailed Poissonnerie prompt have
  different levels of domain guidance; quality parity must be demonstrated with
  trade-specific evaluation data.
