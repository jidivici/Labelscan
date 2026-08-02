# LabelScan Server — PG-0 → PG-6

This is the backend modular monolith for the HACCP seafood traceability system.
**Phase-groups PG-0 … PG-6 are built here** (per `docs/IMPLEMENTATION-PLAN.md`):

- **PG-0** — project structure + dependency-boundary enforcement (G-ARCH).
- **PG-1** — PostgreSQL append-only + audit foundations, installed **before any
  row-writer exists** so the data-integrity SLO (SLO-3) cannot be violated by
  code that doesn't exist yet.
- **PG-2** — the durable ingestion writer (raw payload persisted before ack,
  content-hash idempotency).
- **PG-3** — the transactional outbox + relay worker: the boundary that keeps
  ingestion and extraction strictly decoupled.
- **PG-4** — the extraction consumer (OCR/LLM via ports), the no-fabrication
  validation gate, and append-only `extraction_run` / `extracted_field`.
- **PG-5** — the traceability + HACCP domain: products/suppliers/batches, the
  control-plan rules engine, alerts, consuming validated extractions, and the
  provider-failure retry limit → FAILED runs.
- **PG-6** — the HTTP adapters: the SubmitCapture write (`POST /v1/ingestions`)
  and the read-only query endpoints (`GET /v1/ingestions/{id}`,
  `/v1/extraction-runs/{id}`, `/v1/batches/{id}`, `/v1/alerts`), all with
  problem+json errors per BACKEND §5.2.

> Enterprise OIDC/SSO reste hors périmètre. L’isolation multi-organisation,
> PostgreSQL RLS, les JWT tenantés et le stockage objet S3 compatible sont
> implémentés pour les rôles locaux `admin` et `operator`.

## User backoffice

The API serves the authenticated LabelScan web portal at
`/backoffice/o/{organization_slug}/`. It uses the same-origin tenant login,
`/v1/users`, and
`/v1/stores` routes plus the store-scoped `/v1/arrivals` feed.
It keeps the bearer token in session storage until expiry, so reloads preserve
the session without surviving a browser restart. Administrators manage accounts
and stores; operators see only registered products captured for their assigned
store, searchable by product, lot, GTIN or supplier and filterable by date.

In local Docker Compose, open
[http://localhost:8000/backoffice/o/labelscan/](http://localhost:8000/backoffice/o/labelscan/).
`LABELSCAN_STATIC_DIR` can override the static asset directory when the server
is packaged outside the repository or Docker image.

Provision or reset the initial administrator from the values in `server/.env`:

```bash
docker compose up -d --build
docker compose exec server python -m labelscan.contexts.identity.adapters.cli
```

## Layout (schema-per-context, hexagonal layers)

```
server/
  src/labelscan/
    contexts/<ctx>/{domain,application,adapters}   # 6 bounded contexts, empty skeletons
    platform/db/                                   # engine + transaction-local audit context
    app/                                           # composition root (later)
  migrations/versions/                             # Alembic: 0001 schemas+role, 0002 foundations
  tests/                                           # the three PG-1 proofs
  .importlinter                                    # G-ARCH contracts
  scripts/run_local_proofs.sh                      # ephemeral PG + migrate + G-ARCH + proofs
```

## PG-0 — dependency boundaries (G-ARCH)

`.importlinter` encodes the dependency-direction law (ARCHITECTURE §5) and CI
fails on any violation:

1. **Layering** — within every context: `adapters → application → domain` (never the reverse).
2. **Context independence** — the 6 bounded contexts may not import one another (integrate via events/IDs only).
3. **Domain purity** — `*.domain` may import nothing framework/DB/provider/platform (`sqlalchemy`, `alembic`, `psycopg`, `fastapi`, `httpx`, `pydantic`, `labelscan.platform`, `labelscan.app`).
4. **Application purity** — `*.application` may use its own domain + ports, but no frameworks/DB/providers.

Run: `lint-imports` (requires `include_external_packages = True`, already set).

## PG-1 — append-only + audit foundations

### Immutability (cannot be mutated)
`platform.deny_mutation()` is attached `BEFORE UPDATE OR DELETE` (row-level,
propagated to all partitions) and `BEFORE TRUNCATE` (statement-level) on the
three append-only tables: `ingestion.raw_artifact`, `haccp.temperature_log`,
`audit.audit_log`. The trigger RAISEs for **every** principal — including the
table owner and superuser — so historical records are immutable regardless of
privilege. The app role additionally has UPDATE/DELETE/TRUNCATE **revoked**
(defence in depth).

### Audit (same-transaction, cannot be bypassed or forged)
`platform.audit_on_insert()` is an `AFTER INSERT` `SECURITY DEFINER` trigger on
the audited business tables. It writes **exactly one** `audit.audit_log` row in
the **same transaction**, reading `actor_id`/`action`/`correlation_id`/`trace_id`
from transaction-local settings (`set_config(..., is_local => true)`, see
`platform/db/audit_context.py`). If that context is missing it **RAISEs**,
aborting the insert.

**Design decision (and trade-off).** Audit is enforced at the **database**, not
only in application code. App-level "co-commit" (the AuditLogPort pattern in
BACKEND §3.4) can be bypassed by any direct SQL write; a DB trigger cannot.
- *Gained:* audit is structurally unbypassable, and unforgeable — the app role
  has **no** direct INSERT on `audit_log`; entries exist only via the
  `SECURITY DEFINER` trigger.
- *Given up:* the trigger writes a minimal entry (actor/action/subject/ids). The
  application layer (later PGs) still sets the context and may enrich audit with
  before/after snapshot refs on top of this floor. This is consistent with
  ADR-0004 (append-only audit); it strengthens the unbypassability guarantee.

### Partitioning, roles, idempotency anchor
- The three append-only tables are `PARTITION BY RANGE` on their server timestamp
  (monthly + a DEFAULT partition). The audit trigger records the **logical
  parent** table name (via `pg_partition_root`), never the physical partition.
- `labelscan_app` is a NOLOGIN least-privilege runtime role (tests assume it via
  `SET ROLE`); table ownership stays with the migration role so the app can never
  bypass its own grants.
- `ingestion.raw_artifact` has a content-addressed unique index
  `(ingestion_id, artifact_kind, checksum_sha256, occurred_at)` — the idempotency
  anchor so a duplicate submit never double-appends (used in PG-2).
- `platform.{idempotency_key, outbox, processed_event}` are **mutable** working
  tables (state transitions) — deliberately not append-only.

## PG-2 — durable ingestion writer

The internal ingestion entrypoint is the `SubmitIngestion` use case
(`contexts/ingestion/application/`), wired to adapters by `app/ingestion_factory.py`.
There is **no public HTTP API** yet — "internal only" means the use case is
invoked directly; the HTTP binding is PG-6.

Durability contract (`submit_ingestion.py`):
1. hash the payload (sha256);
2. **persist the raw bytes durably first** — `FilesystemRawStore` writes to a
   temp file, `fsync`s it, atomically renames, and `fsync`s the directory, so the
   bytes survive a crash before any DB row exists (the prod adapter is an
   object store with the same contract);
3. record `ingestion.ingestion` + `ingestion.raw_artifact` in **one audited
   transaction** (the audit context is set first, or the trigger rejects it);
4. return **202 only after commit**.

Idempotency is keyed on the **content hash** (scope = `principal:route:sha256`)
via an atomic `INSERT … ON CONFLICT DO NOTHING` claim on `platform.idempotency_key`,
with the ingestion id generated up front so a duplicate returns the existing id
and writes nothing. `RawArtifact` is a separate aggregate from `Ingestion`, so
`raw_artifact.ingestion_id` is a by-ID link (no FK) — keeping raw immutability
independent of the mutable ingestion lifecycle (ARCHITECTURE §7.2).

### Precondition — SECURITY DEFINER hardening (migration 0003)
- `platform.audit_on_insert` is re-owned by **`labelscan_auditor`**, a NOLOGIN
  non-superuser role whose only privileges are USAGE on `audit` + INSERT on
  `audit_log` (minimal definer role).
- `SET search_path = ''` on both trigger functions (closes search-path capture).
- Strict context validation: `actor_id` must be a valid uuid and the text fields
  are length-bounded, so a malformed/garbage audit actor can never be recorded.

## PG-3 — transactional outbox + relay worker

The outbox (`platform.outbox`) and consumer-dedup (`platform.processed_event`)
tables were created in PG-1; PG-3 wires the pattern:

- **Atomic enqueue.** `SqlIngestionRepository.persist` inserts the
  `ingestion.raw_stored` event into `platform.outbox` **in the same transaction**
  as the ingestion + raw_artifact writes (only on a genuine create — a replay
  enqueues nothing). The event therefore exists if and only if the ingestion
  committed: no lost events, no phantom events.
- **Relay worker** (`platform/outbox/worker.py`). Claims one unpublished row at a
  time with `FOR UPDATE SKIP LOCKED` (safe for multiple workers), runs the
  registered consumers, marks it published — **one transaction per row**. It only
  claims event types it has a handler for.
- **At-least-once + idempotent consumers.** A crash before commit rolls the row
  back to unpublished → retried. Each `(consumer, event_id)` is recorded in
  `platform.processed_event`; a redelivered event a consumer already handled is
  skipped → no duplicate side-effects.
- **Strict decoupling.** Producers only ever INSERT an outbox row; the worker is
  the only reader. Consumers are registered by the **app layer** composition
  root, so the relay (platform) imports no context and the ingestion context
  imports no worker — enforced by the G-ARCH `ingestion-decoupled-from-worker`
  contract. **Ingestion cannot call extraction**, by construction.

PG-3 registers **no consumers** (no extraction, no provider calls — that is PG-4);
`app/worker_runtime.py` builds the worker and a `poll_forever` loop, ready for
later phases to `worker.register("ingestion.raw_stored", "extraction", ...)`.

## PG-4 — extraction + validation gates

The extraction consumer (`contexts/ingestion/adapters/extraction_consumer.py`) is
registered onto the relay for `ingestion.raw_stored` by the app composition root
(`app/extraction_wiring.py`). It never imports the relay's concrete types (it
duck-types the message via a local Protocol), so the `ingestion-decoupled-from-worker`
contract still holds.

Per event it: loads the image → runs OCR → runs the LLM → runs the **domain gate**
→ persists. The transaction model is what delivers the guarantees:

- **External-call dedup.** OCR and LLM each run in their **own** committed
  transaction and store the raw provider output as an immutable `raw_artifact`
  (`ocr_json` / `llm_output`). The existence of that artifact is the guard: on a
  retry the artifact is already there, so the provider is **not called again**.
- **Idempotent consumer.** The persist step (run + fields + status) runs on the
  **worker's** connection, committing atomically with the worker's
  `processed_event` + `published` marks. A committed event is never reprocessed; a
  crash before commit rolls the persist back, so a retry produces **exactly one**
  committed run.
- **No fabrication (the trust boundary).** The pure `domain/extraction.py` gate
  grounds every non-null value in the raw OCR text: a value whose evidence is not a
  verbatim substring is **coerced to null** and flagged `EVIDENCE_NOT_IN_RAW_OCR`.
  Each stored value carries **provenance** (`raw_artifact_id` + span page/offset),
  enforced by a DB CHECK (`value IS NULL OR provenance IS NOT NULL`).
- **Validation gates → HITL.** Missing required fields, low confidence on a
  required field, out-of-vocab / inconsistent values → outcome `needs_review`,
  status `needs_review` (the review queue). **No silent acceptance** — any defect
  routes to review.
- **Append-only, no overwrite.** `extraction_run` and `extracted_field` are
  immutable (deny_mutation). A re-extraction is a NEW run (`attempt_no` increments);
  prior runs are retained. The run is the audited unit; status transitions on
  `ingestion.ingestion` are audited via an AFTER UPDATE trigger.

Required-field rules are supplied as **data** (`RuleSet`, placeholder pending
BLOCKER B2 — Compliance owns the real set); the gate never hard-codes regulatory
truth. The default LLM adapter is **Claude** (`claude-haiku-4-5`, structured
outputs); `claude-opus-4-8` is the off-by-default escalation tier. It is wired
but not exercised by the proof suite (which uses deterministic fakes — no
key/network/spend). Structured output guarantees the *shape*; the gate still
independently enforces *truth*.

## PG-5 — traceability + HACCP domain

The domain-truth layer consumes **validated** extractions and is fully
event-driven, so contexts never import one another (verified by G-ARCH
context-independence):

```
ingestion.raw_stored ─▶ [ingestion] extraction ─▶ extraction.completed
extraction.completed ─▶ [traceability] register/flag ─▶ batch.registered | batch.flagged
batch.registered|flagged ─▶ [haccp] expiry CCP / inconsistency alert
```

- **Traceability** (`contexts/traceability`): on `extraction.completed` with
  outcome `extracted`, runs the domain consistency check (dates, controlled
  vocab, supplier mismatch) and either registers the chain
  (**product → supplier → batch → source extraction run → source ingestion → raw
  artifact**, all append-only, all by-ID across contexts) or records a **flagged**
  batch — inconsistent data is never silently accepted or corrected. Emits
  `batch.registered` / `batch.flagged`.
- **HACCP** (`contexts/haccp`): the pure `domain/control.py` rules engine
  evaluates CCPs against the active **control plan** (versioned, append-only;
  thresholds are Compliance-owned data, not fabricated). The alerting consumer
  raises **expiry** alerts on `batch.registered` and **inconsistency** alerts on
  `batch.flagged`; the temperature recorder logs an immutable reading and raises a
  **temperature** alert on a CCP breach, atomically. Alerts are mutable
  (open→acknowledged→resolved) and audited on insert *and* update.
- **Failure handling:** the extraction consumer retries a failing provider up to
  a limit, then records a **FAILED** `extraction_run` and consumes the event — so
  there is no infinite retry loop (proven).

All new records (product/supplier/batch/control_plan) are append-only +
immutable; only the alert lifecycle mutates. Required-field rules and control-plan
thresholds are **data** (placeholders pending Compliance — BLOCKER B2), never
hard-coded regulatory truth.

## PG-6 — HTTP adapter (SubmitCapture exposure)

`POST /v1/ingestions` (`contexts/ingestion/adapters/http/router.py`) is a thin
adapter over the existing `SubmitIngestion` use case — **no business logic, no new
behaviour**:

- **Transport validation** at the edge: required `Idempotency-Key` header
  (→ `VALIDATION_ERROR`), accepted media type (→ `UNSUPPORTED_MEDIA_TYPE`), size
  (→ `PAYLOAD_TOO_LARGE`).
- **Audit context established before the use case**: the adapter populates
  `actor_id` (from the authenticated principal) and `correlation_id`/`trace_id`
  (from the correlation middleware) into the command; the use case's repository
  then sets them transactionally, so no audited write runs without context.
- **Raw-before-ack**: returns **202 only after** the use case commits (the use
  case stores raw durably + enqueues the outbox in one transaction first).
- **Idempotency**: required header; an idempotent replay returns the stored 202
  with `Idempotency-Replayed: true`. (Dedup itself is content-addressed in the
  repository — a carried PG-2 decision; the header is required and surfaced.)
- **Does not** call any provider and **does not** touch the outbox directly — it
  only invokes the use case.
- **Errors** are RFC 9457 `application/problem+json` with the stable
  `error_code` catalog (`platform/http/errors.py`, BACKEND §5.2) +
  `correlation_id`/`trace_id`.

Auth is the BACKEND §6 seam: `platform/http/security.py` verifies the Bearer JWT
and enforces a per-endpoint scope (fail-closed: `UNAUTHENTICATED` /
`FORBIDDEN`). Trusted gateway headers remain optional and off by default.
OIDC validation is a future adapter replacement for `resolve_principal`. Build
the app with `labelscan.app.http_app:create_app`.

### Read-only query endpoints

`GET /v1/ingestions/{id}` · `/v1/extraction-runs/{id}` · `/v1/batches/{id}` ·
`/v1/alerts` are a pure query adapter — **no writes, no domain logic, read
connections only** — returning read models that reflect exactly what is stored:

- **Append-only fidelity:** `GET /v1/ingestions/{id}` returns **all** extraction
  runs (a re-extraction is a new run, never an overwrite), with the latest marked
  `is_latest` (a derived read projection, not a mutation).
- **Provenance:** each extracted field on `GET /v1/extraction-runs/{id}` carries
  its stored `provenance` (`raw_artifact_id` + spans) and `validation_status`
  verbatim — nothing is reconstructed or "fixed".
- **Audit metadata:** every resource view includes its audit entries
  (`actor_id`, `action`, `occurred_at`) read from the append-only audit log.
- **Status fields** are returned as-is (`ingestion.status`, `extraction_run.outcome`,
  `batch.status`, `alert.state`). `GET /v1/alerts` is filterable + paginated, each
  item joined to its latest audit entry via a single lateral join (no N+1).

Scopes: `ingestion:read` (ingestions/runs), `catalog:read` (store arrivals),
`traceability:read` (batch detail), `haccp:read` (alerts). Read endpoints use
read scopes and never the write scope.

### Alert lifecycle endpoints

`POST /v1/alerts/{id}/acknowledge` · `POST /v1/alerts/{id}/resolve` are thin
adapters that call the application service **only** — no transition logic in the
adapter:

- **State machine in the domain** (`contexts/haccp/domain/alert.py`):
  `open → acknowledged → resolved` (resolve may also go directly from `open`). The
  adapter and repository never decide a transition; they apply the domain's
  decision.
- **Atomic + audited:** the SQL repository locks the row (`FOR UPDATE`), runs the
  domain rule, sets the audit context, and `UPDATE`s — the alert's AFTER UPDATE
  audit trigger **co-commits** the audit row in the same transaction.
- **Invalid transitions rejected:** `InvalidAlertTransition` → `409
  ALERT_INVALID_TRANSITION`, the transaction rolls back, **no state change and no
  audit row** for the rejected attempt. Unknown id → `404`.
- Scopes: `alert:ack` / `alert:resolve` (the `supervisor` role).

## Running it

Local (spins up an ephemeral PG-16, migrates, runs G-ARCH + the proofs, cleans up):

```bash
bash server/scripts/run_local_proofs.sh
```

CI: `.github/workflows/backend-ci.yml` runs G-ARCH, ruff, migrate up → **down to base → up** (reversibility), then the proofs against a `postgres:16` service.

Manual:

```bash
cd server
export DATABASE_URL="postgresql+psycopg://postgres@127.0.0.1:5432/labelscan_test"
pip install -e ".[dev]"
alembic upgrade head      # apply foundations
lint-imports              # G-ARCH
pytest -v                 # the three proofs
```

## The three proofs (map 1:1 to the PG-1 validation requirements)

| File | Proves |
|------|--------|
| `tests/test_immutability.py` | UPDATE/DELETE/TRUNCATE fail at the DB level for owner (trigger) and app role (privilege + trigger), incl. on `audit_log`. → *mutation is impossible*. |
| `tests/test_audit_same_transaction.py` | every audited INSERT yields exactly one matching audit row in the same tx; an insert with no audit context is rejected; the app role cannot insert audit rows directly. → *audit cannot be bypassed or forged*. |
| `tests/test_rollback.py` | a transaction rollback removes the business row **and** its audit row together. |
| `tests/test_ingestion_durability.py` | 202 only after the durable write; duplicate ingestion → no duplicate record; crash-before-ack → data present + idempotent retry; DB-fails-after-PUT → bytes not lost, no partial record; no ingestion write without audit context. |
| `tests/test_secdef_hardening.py` | audit fn is SECURITY DEFINER owned by the minimal non-superuser role with `search_path=''`; a non-uuid actor is rejected. |
| `tests/test_outbox_worker.py` | ingestion enqueues the outbox row atomically (and not on replay); a failed ingestion leaves no outbox row; worker crash → message retried; redelivery → no duplicate side-effect; crash mid-batch → unprocessed messages retained (no loss) and each processed exactly once. |
| `tests/test_extraction_gate.py` | (pure domain) happy path → extracted with provenance; fabricated value coerced to null + flagged; missing required / low confidence / out-of-vocab / inconsistent dates → needs_review. |
| `tests/test_extraction_consumer.py` | end-to-end: produces run + fields + provenance; duplicate event → no duplicate run/calls; crash-then-retry → exactly one run and no repeated external calls; invalid extraction → not marked valid (review queue, value nulled); re-extraction is a new append-only run and prior runs are immutable. |
| `tests/test_haccp_rules.py` | (pure) temperature above-max/below-min/in-range; expiry passed/approaching/far. |
| `tests/test_temperature_alerts.py` | temperature breach raises an alert + logs the reading; in-range logs but raises nothing. |
| `tests/test_traceability_chain.py` | validated extraction → registered batch with a full queryable chain + expiry alert; supplier mismatch → flagged batch + inconsistency alert; batch is append-only. |
| `tests/test_extraction_failure.py` | provider failure → FAILED run after the retry limit, event consumed, no infinite loop. |
| `tests/test_ingestion_http.py` | 202 after durable write (row + outbox event present, no extraction_run); duplicate → 202 replay + `Idempotency-Replayed`; missing key → 400; bad media → 415; no auth → 401; missing scope → 403; all errors are problem+json with `error_code` + `correlation_id`. |
| `tests/test_read_endpoints.py` | ingestion view returns all runs (1 latest) + raw artifacts + audit; run view returns field provenance (raw_artifact_id + spans) + status + audit; batch view returns chain + alerts + status + audit; alerts list filterable with per-item audit; unknown id → 404; read requires a read scope. |
| `tests/test_alert_lifecycle.py` | open→acknowledged→resolved (and open→resolved) applied with co-committed audit; invalid transitions → 409 with no state change and no audit row; unknown id → 404; missing scope → 403. |

All 69 pass against PostgreSQL 16. The STOP conditions ("if audit can be
bypassed" / "if mutation is possible") are not reachable.
