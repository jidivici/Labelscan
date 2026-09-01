# LabelScan — Phase 2 Controlled Implementation Plan

> **Archived:** Superseded implementation plan, not a current backlog. See the
> [archive index](README.md) and [developer guide](../DEVELOPER-GUIDE.md).

**Status:** Phases PG-0 through PG-5 IMPLEMENTED; PG-6 PARTIALLY IMPLEMENTED.
This document remains the reference for the build plan; implementation status is noted per phase-group.
**Date:** 2026-06-18 (updated from 2026-06-14 plan)
**Author:** Software Architect (with Backend Architect concerns)
**Scope:** `LabelScan/` only. Sibling projects out of scope.
**System:** HACCP-oriented seafood traceability for large-scale retail fishmongery.

> This document translates the already-synthesised design into a strictly-ordered, incremental,
> verifiable build plan. It **introduces no new** endpoints, tables, fields, events, or design
> decisions. Everything below references existing artifacts by `file:§`. The authoritative
> reference is [`docs/SYNTHESIS.md`](./SYNTHESIS.md); where it cites an owning document
> (`ARCHITECTURE.md`, `backend/BACKEND-ARCHITECTURE.md`, `database/schema.sql`,
> `pipeline/PIPELINE-ARCHITECTURE.md`, `pipeline/eval-suite.md`, `ai-pipeline/AI-PIPELINE.md`,
> `operations/SRE-RELIABILITY.md`), that owner remains authoritative here.
>
> The carried BLOCKERs **B1–B6** (`SYNTHESIS.md §8`) are **inputs to be resolved by their owners**,
> not invented here. Each is routed to the step where it must land (§6). All
> NEEDS-VERIFICATION / NEEDS-CONFIRMATION flags from the source docs are preserved, not resolved.

---

## 1. Plan overview & ordering rationale

### 1.1 The six ordered phase-groups (mapped to ARCHITECTURE §9 phases 0–5)

The build follows the brief's mandated sequence, which is a refinement of the identical Phase 0–5
ordering confirmed CONSISTENT across `ARCHITECTURE.md §9`, `AUDIT.md §4`, and `BACKEND §11.4`
(`SYNTHESIS.md` C18). The brief sharpens it by splitting Phase 1 into "database+audit foundations"
(PG-1) and "ingestion writers" (PG-2/PG-3), so that **no writer can run before append-only and
audit are provable**.

| PG | Phase-group | ARCHITECTURE §9 phase | What it lands |
|----|-------------|------------------------|---------------|
| **PG-0** | Skeleton & dependency-law CI | Phase 0 (Foundations) | `server/` modular-monolith skeleton, framework-free `domain/`, ports, `import-linter`/arch-test gate. No user-facing behaviour. |
| **PG-1** | **Database + audit foundations FIRST** | Phase 0/1 (Foundations) | schemas-per-context; append-only DDL (REVOKE + `deny_mutation` triggers); `audit_log` + audit-write path; `idempotency_key` + `processed_event` + `outbox`; partitioning. **Nothing else builds before append-only + audit are provable.** |
| **PG-2** | Ingestion (raw store + idempotency) | Phase 1 (Immutable ingestion) | object store + `raw_artifact` metadata append; HTTP `Idempotency-Key` + content-addressed checksum; `POST /v1/ingestions` returns 202. Raw stored **BEFORE** anything normalized. |
| **PG-3** | Async pipeline (outbox + worker) | Phase 1→2 boundary | transactional outbox dispatcher + extraction worker; ingestion enqueues, worker consumes. **No synchronous coupling** ingestion↔extraction. |
| **PG-4** | Extraction + validation gates | Phase 2 (Extraction + confidence) | `OcrPort`/`LlmExtractorPort` adapters behind ports; schema + no-fabrication (evidence-substring) trust-boundary gate; confidence/threshold routing; HITL review branch. |
| **PG-5** | Domain (traceability + HACCP) | Phase 3+4 (Domain/validation, Traceability/HACCP) | products/batches/suppliers; compliance rule-set snapshot; control plans, temperature logs, alerts, expiry/temperature monitoring. |
| **PG-6** | API exposure + thin-client cutover | Phase 4→5 | `/v1` endpoints wired to the above with auth scopes; Expo strangler dual-write through to thin-client cutover (Phase 5) last. |

### 1.2 Why this order makes SLO-3 violations structurally impossible

`SRE §1 SLO-3` defines two **un-budgeted, page-on-any-breach** integrity SLIs:
**SLO-3a** raw-artifact durability (100% — a 202 is a promise of durable raw storage) and
**SLO-3b** audit completeness (100% — every business-critical transition has exactly one append-only
audit row). `SRE §2.2` makes any breach a SEV1 that auto-freezes all releases.

The ordering makes both **structurally** safe rather than relying on discipline:

1. **Append-only enforcement exists before any writer.** PG-1 installs `REVOKE UPDATE/DELETE` +
   the `platform.deny_mutation()` triggers on `raw_artifact`, `audit_log`, `temperature_log`
   (`schema.sql` "IMMUTABILITY ENFORCEMENT"; `ARCHITECTURE §7.1/§7.2`; ADR-0003/0004) **before**
   PG-2 introduces the first row-writer. A writer therefore *cannot* mutate history even if mis-coded —
   the DB rejects it. This is `SYNTHESIS.md §8` guardrail (b) realized as ordering.
2. **The audit-write path exists before the writers that must co-commit to it.** PG-1 lands
   `audit_log` + `AuditLogPort` so PG-2..PG-5 writers can co-commit their audit entry **in the same
   transaction** (`BACKEND §12 S8`, `SRE §3` "audit completeness is a prime directive"). Guardrail (a).
3. **Raw is durable before the ack, and before extraction exists at all.** PG-2 writes
   `raw_artifact` (object store + metadata) and only then returns 202; PG-3/PG-4 (extraction) are
   built *after*, so there is no code path where extraction precedes durable raw storage
   (`ARCHITECTURE §3.1/§7.2`, ADR-0003; pipeline step 1 in `SYNTHESIS.md §5`). Guardrail (c) ordering.
4. **Idempotency tables exist before retryable writers.** PG-1 lands `idempotency_key`,
   `processed_event`, and the content-addressed `uq_raw_artifact_content` index, so PG-2's retried
   submit replays rather than double-appends (`BACKEND §7`, `SYNTHESIS.md` C19).

If any later step, **as ordered**, would introduce a writer before its guarantee exists, it is a
**STOP / ordering BLOCKER** (§6). The whole point of "DB+audit first" is to remove the human's
ability to violate SLO-3.

### 1.3 Strangler approach to the existing Expo app

No big-bang rewrite (`ARCHITECTURE §9`, `BACKEND §11.1`). The existing Expo client
(`CameraScreen.tsx → ReviewScreen.tsx → storage.ts`) keeps working **unchanged** through PG-0..PG-5.
PG-2's `POST /v1/ingestions` is deliberately shaped to accept the *same* payload the app already
produces (`image` + `meta.barcode_raw` + `meta.client_captured_at`, `BACKEND §11.1`), so the app can
**dual-write behind a feature flag** with no UX change. The app is *strangled* into a thin client only
in PG-6 / Phase 5; AsyncStorage degrades to a local cache/outbox so a backend outage falls back to
offline-queued capture, never data loss (`ARCHITECTURE §9 Phase 5`, fixes R9).

### 1.4 "Definition of done / shippable" bar (applied to EVERY step)

A step is *done* only if ALL hold (this is the bar referenced per step in §3):

1. It leaves the system in a **working, shippable** state (the Expo app still works; previously
   shipped endpoints still pass contract tests).
2. It is **independently shippable and individually reversible** (rollback defined; see §3 field 4).
3. The **cross-cutting CI gates** in §2 pass (boundary arch-tests, migration reversibility check,
   audit-co-commit test, durability verification where applicable, eval-suite thresholds).
4. The relevant **SLO/observability signal** is emitted and green in canary (§5), with SLO-3
   un-budgeted for any step that touches raw/audit/outbox/ingestion-durability.
5. It preserves the named **invariants** (§3 field 2) and breaks none.

---

## 2. Cross-cutting guardrails (enforced on EVERY step — stated once, referenced per step)

These CI/promotion gates run on every PR. Per-step entries in §3 reference them by ID rather than
restate them.

| ID | Gate | What it enforces | Source |
|----|------|------------------|--------|
| **G-ARCH** | **import-linter + arch-test** | The dependency law: `domain/` imports nothing framework/DB/provider; `adapters→application→domain`; `shared_kernel` is a leaf; **no cross-context `domain`/`application` import**; cross-context only via events/by-ID. A pytest AST walk of `domain/` is the config-drift-proof safety net. Fails the build on violation. | `ARCHITECTURE §5.2/§5.3/§5.4` |
| **G-MIG** | **Migration reversibility check** | Every schema change is expand-and-contract; **expand is reversible (down-migration exists), contract is NOT reversible in the same release** — CI rejects an expand+contract in one release. Append-only tables: additive nullable columns only; backfill on immutable tables only via the audited `labelscan_maint` role. | `BACKEND §11.2`, `DATABASE §6`, `SRE §7.2`, `schema.sql §0 roles`, migrations `0001`/`0002` |
| **G-AUDIT** | **Audit-co-commit test** | Every business-critical write integration test asserts **exactly one** matching `audit_log` row was appended **in the same transaction** (SLO-3b). A write with no audit row fails the test; a doubled audit row fails. No API write-path to `audit_log` (405). | `BACKEND §12 S8`, `SRE §1 SLO-3b/§3`, ADR-0004 |
| **G-DUR** | **Durability verification** | For ingestion/raw/outbox-touching steps: the durability-audit job (`SRE §10` item 1) confirms every 202's raw artifact is later readable + checksum-valid (SLO-3a). Runs continuously in canary; pages SEV1 on any gap. | `SRE §1 SLO-3a/§7.1/§10` |
| **G-EVAL** | **Eval-suite thresholds** | The `eval-suite.md` CI pipeline: stage unit evals, prompt evals SC1/SC3/SC10 (hard), pipeline categories **E01–E25** (hard-gate set E04, E05, E14, E15, E20, E22, E23, E24 = 100% pass; soft no-regress vs baseline across 3 runs); schema meta-validation; OpenAPI contract tests; error/log-code registries append-only. | `eval-suite.md §3/§4` |
| **G-SLO** | **SLO / canary promotion gate** | Canary 5% → 25% → 50% → 100% (`SRE §7.1`); a stage **cannot promote** while the relevant SLO is in freeze (`SRE §2.3`); auto-halt + auto-rollback on fast-burn breach; for durability-touching changes, canary must show **100%** on G-DUR before promotion. | `SRE §7.1/§2.3` |

**Anti-pattern guardrails (the three the brief mandates), enforced where each is introduced:**

- **(a) No write bypasses the audit log** → enforced by **G-AUDIT** on every writer; structurally
  guaranteed because PG-1 builds `audit_log` + `AuditLogPort` *before* the first writer (PG-2).
- **(b) No mutation of historical records** → enforced at the DB level by PG-1 (REVOKE + trigger)
  *before* any writer exists; corrections create a **new `ExtractionRun`** / a **new `extracted_field`**
  row (`schema.sql` `is_superseded`/`superseded_by_field_id`; ADR-0003; `SYNTHESIS.md` C20). Verified
  by eval **E25** and a trigger-violation test.
- **(c) No synchronous coupling ingestion↔extraction** → the outbox/worker boundary is built in
  **PG-3**; PG-2 ingestion **must never** call `OcrPort`/`LlmExtractorPort` inline. Enforced by
  G-ARCH (ingestion HTTP adapter may not import the worker/extraction adapters) and a test asserting
  the submit path performs no provider call (`BACKEND §1.1/§9`, `SYNTHESIS.md §5` async hop).

---

## 3. Step-by-step plan

Each step has exactly four fields: **Scope · Invariants to preserve · Validation criteria ·
Rollback strategy.** Module paths use the `BACKEND §2.2` layout
(`contexts/<ctx>/{domain,application,adapters}`, `platform/*`, `app/*`) and `schema.sql` schemas.
Invariant shorthand: `{append-only audit, historical immutability, idempotency, raw-before-normalized,
dependency-direction law, correlation_id/trace_id}`.

---

### PG-0 — Skeleton & dependency-law CI (ARCHITECTURE §9 Phase 0)

#### Step 0.1 — `server/` skeleton + composition root + observability middleware
- **Scope:** Create `server/` tree per `ARCHITECTURE §3.2` + `BACKEND §2.2`: `app/main.py`
  (composition root, empty wiring), `app/worker.py` (entry only), `shared_kernel/{ids,confidence,
  correlation,events}.py`, `platform/{db,messaging,observability,config}.py`,
  `platform/http/{middleware,errors,idempotency}.py` (skeletons). No routers mounted, no user
  behaviour. `pyproject.toml`.
- **Invariants to preserve:** dependency-direction law (the tree *is* the law made physical);
  correlation_id/trace_id (middleware reads/generates `X-Correlation-Id` + W3C trace and binds to a
  context var, `BACKEND §10.1`).
- **Validation criteria:** `import-linter`/arch-test config present and green over the empty tree
  (**G-ARCH**); `GET /v1/health/live`/`ready`/`version` respond (`BACKEND §3` ops endpoints);
  unit test asserts middleware injects correlation/trace into a log line. No eval categories yet.
- **Rollback strategy:** pure addition — delete `server/`; zero client impact (`BACKEND §11.4`
  Phase 0). Trivially reversible.

#### Step 0.2 — Ports defined in `domain/ports/` + in-process EventBus port
- **Scope:** Declare the `ARCHITECTURE §3.3` ports as interfaces inside each owning context's
  `domain/ports/`: `OcrPort`, `LlmExtractorPort`, `RawArtifactRepository`, `IngestionRepository`,
  `ObjectStore`, `Clock`, `AuditLogPort`, `EventBus`, and inbound `SubmitCapture`/`RunExtraction`/
  `ConfirmExtraction`. Interfaces only; no adapters.
- **Invariants to preserve:** dependency-direction law (ports owned by domain so the arrow points
  inward; **no new ports** introduced — exactly `ARCHITECTURE §3.3`).
- **Validation criteria:** G-ARCH proves `domain/ports/` imports nothing framework-bound; a fake
  adapter wired in tests satisfies each port signature. No eval categories yet.
- **Rollback strategy:** additive; remove the port modules. Trivial.

---

### PG-1 — Database + audit foundations FIRST (ARCHITECTURE §9 Phase 0/1)

> **This phase-group must complete before ANY row-writer (PG-2+). See §1.2.** It makes SLO-3
> structurally enforceable.

#### Step 1.1 — Schemas-per-context + cross-context reference policy
- **Scope:** `schema.sql §1` — `CREATE SCHEMA` for `ingestion, compliance, traceability, haccp,
  audit, identity, platform`; install the `platform.deny_mutation()` function (`schema.sql`
  IMMUTABILITY ENFORCEMENT). DB roles `labelscan_app` / `labelscan_maint` (`schema.sql §0`).
- **Invariants to preserve:** dependency-direction law at the DB tier (**FK only within a schema**;
  cross-context links are plain indexed `uuid` columns, `schema.sql §2`, `SYNTHESIS.md §4.4`).
- **Validation criteria:** migration applies + down-migration drops cleanly (**G-MIG**); a test
  asserts no cross-schema FK exists (boundary check, `ARCHITECTURE §5.3`). EXPLAIN not yet relevant.
- **Rollback strategy:** down-migration drops the schemas (empty at this point). Reversible.

#### Step 1.2 — Append-only enforcement DDL (the structural SLO-3 floor)
- **Scope:** `audit.audit_log` (partitioned by `occurred_at`), `ingestion.raw_artifact`
  (partitioned by `occurred_at`), `haccp.temperature_log` (partitioned by `recorded_at`) tables +
  their partitions; the three `BEFORE UPDATE OR DELETE` `deny_mutation` triggers; the
  `REVOKE UPDATE, DELETE, TRUNCATE ... FROM labelscan_app` + `GRANT INSERT, SELECT` grants
  (`schema.sql` IMMUTABILITY ENFORCEMENT). Partition-creation maintenance job stub.
- **Invariants to preserve:** **historical immutability** + **append-only audit** — installed here,
  *before* any writer, so guardrail (b) is structural; correlation_id/trace_id are `NOT NULL` on
  all three tables (`schema.sql`).
- **Validation criteria:** a trigger-violation test asserts `UPDATE`/`DELETE` on each of the three
  tables RAISEs (eval suite §5 notes no UPDATE/DELETE path exists by construction); EXPLAIN-ANALYZE
  the partition-pruning on a date-bounded `SELECT` of `raw_artifact`/`audit_log` confirms only the
  target partition is scanned (`DATABASE §7` partitioning); G-MIG (expand reversible). **This step
  is a prerequisite gate for all of PG-2+** (§4).
- **Rollback strategy:** down-migration drops tables/triggers (still empty). **NOTE:** once rows
  exist (after PG-2), dropping these is **NOT trivially reversible** — by design (`BACKEND §13`
  "intentionally hard to reverse — that's the value"). At this step, pre-data, it is reversible.

#### Step 1.3 — `AuditLogPort` append path + audit context
- **Scope:** `contexts/audit/` (thin, layered): `application` `AppendAuditEntry`, `adapters/outbound`
  `PostgresAuditLog` implementing `AuditLogPort` (INSERT-only into `audit.audit_log`), read-side
  `QueryAudit`. No HTTP write path (`BACKEND §4.9` — 405 on write).
- **Invariants to preserve:** append-only audit (writes only via `AuditLogPort`, same-txn co-commit
  contract is exercisable by later writers); correlation_id/trace_id propagated into every entry
  (`schema.sql audit_log` `NOT NULL`).
- **Validation criteria:** **G-AUDIT** harness exists and a fixture business action co-commits
  exactly one audit row in the same transaction; attempting an HTTP write returns 405; G-ARCH
  (audit context imports no other context's domain). Optional hash-chain columns left nullable
  (`SYNTHESIS.md` C8, B4 deferred).
- **Rollback strategy:** drop the `audit` adapter wiring; the table remains (append-only). Reversible
  at code level; table data is permanent by design.

#### Step 1.4 — Idempotency + dedup + transactional outbox tables
- **Scope:** `platform.idempotency_key`, `platform.processed_event`, `platform.outbox`
  (`schema.sql §platform`) + their indexes (`idx_idempotency_expires`, `idx_outbox_undispatched`);
  `platform/http/idempotency.py` store/replay helper (`BACKEND §7.2/§7.3`); TTL sweep job stub.
- **Invariants to preserve:** idempotency (two-layer: HTTP key + `event_id` dedup, `BACKEND §7.4`,
  `SYNTHESIS.md` C19); correlation_id/trace_id on `outbox`.
- **Validation criteria:** unit tests for replay semantics (same key+fingerprint → replay;
  same key+different fingerprint → 409 `IDEMPOTENCY_KEY_CONFLICT`; `event_id` re-delivery → no-op);
  EXPLAIN-ANALYZE confirms `idx_outbox_undispatched` partial index is used by the dispatcher poll
  (`dispatched_at IS NULL`). G-MIG. Eval **E24** harness wired (asserted fully in PG-2/PG-3).
- **Rollback strategy:** down-migration drops the three tables (empty). Reversible.

---

### PG-2 — Ingestion: raw store + idempotency (ARCHITECTURE §9 Phase 1)

> Raw stored **BEFORE** anything normalized. No provider calls on this path (guardrail (c)).

#### Step 2.1 — Ingestion aggregate + repositories (no extraction)
- **Scope:** `contexts/ingestion/domain/model` (`Ingestion` aggregate root, status state machine =
  the 12 states in `schema.sql ingestion.ingestion` CHECK / `SYNTHESIS.md §4.3`); `ingestion.ingestion`
  table; `adapters/outbound` `PostgresIngestionRepository`, `SystemClock`. `RawArtifactRepository`
  + `ObjectStore` ports' Postgres/object-store adapters (append into `ingestion.raw_artifact`,
  content-addressed key).
- **Invariants to preserve:** raw-before-normalized (the aggregate forbids advancing past
  `raw_stored` without a raw-artifact reference, `ARCHITECTURE §7.1`); historical immutability
  (raw append is write-once, enforced by PG-1 trigger); dependency-direction law; correlation_id/
  trace_id NOT NULL.
- **Validation criteria:** integration test: append image to object store → append `raw_artifact`
  metadata → save `ingestion(status=raw_stored)`; EXPLAIN-ANALYZE `uq_raw_artifact_content` is used
  for the content-addressed dedup lookup; trigger blocks any update to a written raw row; **G-DUR**
  fixture confirms checksum-valid readback (SLO-3a). G-ARCH, G-AUDIT.
- **Rollback strategy:** feature-flag the endpoint off (Step 2.2); repositories are additive. Raw
  store is additive/append-only. Code-level reversible; persisted raw is permanent by design.

#### Step 2.2 — `POST /v1/ingestions` (SubmitCapture use case, 202, same-txn audit + outbox)
- **Scope:** `contexts/ingestion/application` `SubmitCapture`; `adapters/inbound/http` router +
  Pydantic DTOs (`BACKEND §4.1`, multipart `image` + `meta`); the submit transaction co-commits
  `raw_artifact`(append) + `ingestion`(insert) + `audit_log`(append) + `outbox`(enqueue
  `RunExtraction`) + `idempotency_key` (`SYNTHESIS.md §5` step 1). Returns **202** `raw_stored`.
  Wire `Idempotency-Key` middleware, body-size limit, auth scope `ingestion:write` (`BACKEND §6.2`).
- **Invariants to preserve:** raw-before-normalized (raw durably stored before 202);
  **append-only audit** (audit row co-committed in the *same* DB txn — guardrail (a));
  **idempotency** (HTTP key + content checksum, `BACKEND §7.4` — guardrail prevents duplicate
  ingestions); **no synchronous coupling** (the use case enqueues an outbox row; it does **not** call
  OCR/LLM — guardrail (c)); correlation_id/trace_id stamped server-side (`BACKEND §10.1`).
- **Validation criteria:** eval **E24** (idempotent replay: same image+key → original `ingestion_id`,
  no second raw append, no second audit entry, `Idempotency-Replayed:true`); **E02** raw-image-stored-
  before-OCR precondition (`raw_image_ref` set pre-OCR — OCR not yet built, so assert raw+202 only);
  G-AUDIT (exactly one audit row per submit); G-DUR continuous in canary (SLO-3a 100%); error-path
  tests for `413/415/422/409/429/503` (`BACKEND §5.2`); a test asserts the submit path makes **zero**
  provider calls (guardrail (c)). SLO signals: SLO-1 availability, SLO-2a submit p95<1.5s.
- **Rollback strategy:** **feature flag** the route + the client dual-write off (`BACKEND §11.4`
  Phase 1) → app reverts to local-only, backend idle, store additive; redeploy-previous-image for
  the stateless API. `ingestion.fail_closed` kill-switch (`SRE §7.3`) returns 503 if durability
  can't be guaranteed (RB-2) rather than ack-without-durability. Reversible.

#### Step 2.3 — Ingestion read endpoints + image fetch
- **Scope:** `GET /v1/ingestions`, `/{id}`, `/{id}/image` (signed-URL redirect to object store)
  (`BACKEND §3.A`); scope `ingestion:read`.
- **Invariants to preserve:** dependency-direction law; correlation_id/trace_id echoed.
- **Validation criteria:** contract tests (G-EVAL OpenAPI); EXPLAIN-ANALYZE
  `idx_ingestion_status_received` used by the list/worklist query (`schema.sql`); SLO-2b read
  p95<200ms.
- **Rollback strategy:** read-only, side-effect-free → redeploy-previous-image. Trivial.

---

### PG-3 — Async pipeline: outbox dispatcher + worker (ARCHITECTURE §9 Phase 1→2)

> Builds the boundary that makes guardrail (c) real. Ingestion (PG-2) already only enqueues.

#### Step 3.1 — Outbox dispatcher (at-least-once, DLQ)
- **Scope:** `platform/messaging.py` dispatcher polling `platform.outbox WHERE dispatched_at IS NULL`
  (`schema.sql idx_outbox_undispatched`); retry-with-backoff up to max → dead-letter
  (`BACKEND §9.3`); `EventBus` in-process impl. No extraction logic yet.
- **Invariants to preserve:** idempotency (consumers dedup on `event_id` via `processed_event`,
  `BACKEND §7.4`); correlation_id/trace_id ride the envelope across the async hop (`BACKEND §10.3`).
- **Validation criteria:** integration test: an enqueued outbox row is dispatched exactly-effectively-
  once (consumer idempotent on `event_id`); poison message → dead-letter, never silently dropped;
  EXPLAIN-ANALYZE confirms the partial-index poll. Eval **E24** event-bus arm (re-deliver same
  `event_id` → no double processing). SLO signal: outbox/DLQ depth + age (`SRE §3.1`).
- **Rollback strategy:** dispatcher is a separate loop; disable it → outbox rows accrue durably
  (no loss), processed when re-enabled. Redeploy-previous-image. Reversible.

#### Step 3.2 — Extraction worker shell (`RunExtraction` orchestrator, no providers yet)
- **Scope:** `app/worker.py` consuming `RunExtraction`; `contexts/ingestion/application RunExtraction`
  orchestrator owning the envelope/task ledger (`SYNTHESIS.md §5`); transitions `raw_stored →
  ocr_running` then no-op (providers land in PG-4). Worker reuses `main.py` wiring minus HTTP
  (`BACKEND §2.4`).
- **Invariants to preserve:** **no synchronous coupling** (worker consumes the event; ingestion never
  calls it — guardrail (c) now physically separated); correlation_id/trace_id continuity across the
  hop; append-only audit (worker co-commits audit on state transitions).
- **Validation criteria:** integration test: submit → 202 → worker picks up the event → ingestion
  status advances; trace spans stitch across the async hop (`BACKEND §10.3`); worker dead-man's-switch
  heartbeat present (`SRE §10` worker liveness). SLO-4a extraction reaches a terminal state; G-AUDIT.
- **Rollback strategy:** worker is stateless → redeploy-previous-image; if worker is down, ingestion
  still 202s and raw is stored, extraction simply pauses (`SRE §10`) — no SLO-3 impact. Reversible.

---

### PG-4 — Extraction + validation gates (ARCHITECTURE §9 Phase 2)

#### Step 4.1 — OCR adapter behind `OcrPort` + raw OCR append + OCR-quality gate
- **Scope:** `contexts/ingestion/adapters/outbound/ocr_google_vision.py` implementing `OcrPort`
  (ACL to Google Vision, `SYNTHESIS.md` C12 default adapter); worker appends raw OCR JSON to
  `raw_artifact(artifact_kind='ocr_json')` (`schema.sql`); `mean_token_confidence` on
  `extraction_run`; OCR-quality gate (`proceed`/`skip_garbage`/`review`, `SYNTHESIS.md §5` step 4).
  Per-dependency timeout/retry/breaker (`BACKEND §9.1`).
- **Invariants to preserve:** raw-before-normalized (raw OCR JSON appended *before* extraction
  interprets it; append-only); historical immutability; dependency-direction law (provider SDK only
  in the adapter); correlation_id/trace_id.
- **Validation criteria:** eval **E02** (OCR runs, raw image stored pre-OCR, quality `proceed`),
  **E05** (garbage → `skip_garbage`, LLM skipped, raw retained, `unreadable`), **E16** (non-food →
  `review`/all-null, `NON_FOOD_CONTENT_SUSPECTED`), **E22** (OCR timeout → ≤3 retries → `ocr_failed`,
  raw already stored, never blocks ingestion). G-ARCH, G-EVAL. SLO-4 pipeline success.
- **Rollback strategy:** `OcrPort` is a port — swap the adapter or revert to a no-op; re-extraction
  is additive (new run). `extractor.*` kill-switches (`SRE §7.3`). Redeploy-previous-image. Reversible.

#### Step 4.2 — LLM extractor behind `LlmExtractorPort` (unknown ⇒ null, bounded repair)
- **Scope:** `adapters/outbound/llm_extractor_*.py` implementing `LlmExtractorPort` (ACL to
  `claude-haiku-4-5` default (escalation `claude-opus-4-8`, off by default), per `SYNTHESIS.md` C12 / ADR-0002); emits `extraction.v1` shape; unknown ⇒ `null`;
  ≤2 bounded repair re-asks (`SYNTHESIS.md §5` step 5); writes `extraction_run`
  (`raw_output_ref`, `extractor_version`, `schema_version`). Timeout/retry/breaker (`BACKEND §9.1`).
- **Invariants to preserve:** historical immutability (each run is a NEW `extraction_run`,
  `is_superseded` on prior — ADR-0003); dependency-direction law (LLM SDK only in adapter);
  correlation_id/trace_id.
- **Validation criteria:** prompt evals SC1/SC3/SC10 (hard); eval **E20** (invalid JSON → ≤2 repair
  → `extraction_failed`, raw retained, zero fabricated fields), **E21** (off-schema → same path, no
  hand-merge), **E23** (LLM timeout → ≤2 retries → `extraction_failed`, `provider_degraded`, no
  fabrication), **E25** (re-extraction additive: new `extraction_run_id`, prior + raw retained).
  G-EVAL hard gates 100%. SLO-4b freshness p95<60s.
- **Rollback strategy:** port swap / `extractor.model`/`extractor.prompt_version` kill-switch
  (`SRE §7.3`); re-extract is additive (never overwrites raw). Redeploy-previous-image. Reversible.

#### Step 4.3 — Schema + no-fabrication (evidence-substring) trust-boundary gate
- **Scope:** `contexts/ingestion/application` gate (`BACKEND §8.2.1/§8.2.2`, `SYNTHESIS.md §5` step
  6): strict schema validation; **evidence = exact substring of raw OCR**; values that cannot be tied
  to raw OCR are coerced to `null` with `reason: unverifiable`; security flags
  (`EVIDENCE_NOT_IN_RAW_OCR`, `INJECTION_LANGUAGE_DETECTED`) → quarantine → review. Persist 15
  `extracted_field` rows (`schema.sql` CHECK; label-level `raw_warnings` on `extraction_run` —
  `SYNTHESIS.md` C1/§4.1). Enforces `ck_evidence_iff_value`.
- **Invariants to preserve:** **no fabrication** (the trust boundary — constraint #1/#c); historical
  immutability; append-only audit (gate outcome audited); dependency-direction law (gate is domain/
  application, frameworks excluded).
- **Validation criteria:** eval **E03** (garble kept verbatim, no spell-fix), **E14** (prompt
  injection: instruction not obeyed, flag raised, quarantined), **E15** (fabricated evidence →
  coerced null `unverifiable`, `EVIDENCE_NOT_IN_RAW_OCR`), **E11** (FAO place-name → no code mapped).
  `evidence_gate_reject_total` hallucination detector (`SRE §5.2`). G-EVAL hard gates E14/E15 = 100%.
- **Rollback strategy:** the gate is the safety boundary — **not** disable-able to "trust the model";
  rollback = redeploy-previous-gate-image only. **Flagged: rollback here is NOT a relaxation** (you
  may roll back to a prior *correct* gate, never to "no gate"). Reversible only to a prior safe version.

#### Step 4.4 — Confidence/threshold routing + HITL review branch
- **Scope:** `application` compute `combined_confidence`/`confidence_band` (AI-PIPELINE §4 owns the
  combination; DB stores it, `SYNTHESIS.md` C3); route auto-ok → `extracted` +
  `LabelExtractionCompleted` vs flagged → `needs_review` + `ExtractionFlaggedForReview`
  (`SYNTHESIS.md §5` step 8); HITL endpoints `PATCH /v1/ingestions/{id}/fields/{name}`
  (`extraction:review`), `POST .../confirm` (`extraction:confirm`), `POST .../reject`
  (`SYNTHESIS.md §6`). Override inserts a **new** `extracted_field` (`source='human'`); confirm
  creates a **new** `extraction_run`.
- **Invariants to preserve:** historical immutability (override = new row, original retained; confirm
  = new run — guardrail (b), `schema.sql superseded_by_field_id`); append-only audit (every override/
  confirm/reject co-commits audit); idempotency (review/confirm/reject require `Idempotency-Key`,
  `BACKEND §3.C`); correlation_id/trace_id.
- **Validation criteria:** eval **E04** (missing required → `needs_review`, `ExtractionFlaggedForReview`),
  **E18** (low-confidence required → review, not auto-confirmed), **E19** (calibration ECE≤0.10,
  review-queue not flooded/starved), **E06/E10/E12/E13/E17** (ambiguity/vocab → review). G-AUDIT on
  override/confirm/reject; `409 INGESTION_INVALID_STATE` on confirm-after-confirmed (`BACKEND §5.2`).
  SLO-4 (`needs_review` counts as success, `SRE §1 SLO-4a`).
- **Rollback strategy:** routing thresholds are versioned `Confidence` VO bands (not floats) → adjust
  via config; HITL endpoints feature-flagged. Confirm/override are additive (new rows). Redeploy-
  previous-image. Reversible.

---

### PG-5 — Domain: traceability + HACCP (ARCHITECTURE §9 Phase 3+4)

> **B2 (required-field rule-set contents) MUST be authored/versioned before the validation gate
> runs in enforce mode** (§6). Until then, validation runs **warn-only** (`BACKEND §8.3`,
> `eval-suite §4` warn-only rollout, `ARCHITECTURE §9 Phase 3` reversibility).

#### Step 5.1 — Compliance rule-set snapshot + controlled vocabularies (read-only to the gate)
- **Scope:** `contexts/compliance/` (layered): `compliance.required_field_rule_set`,
  `compliance.species`, `compliance.fao_area` tables (`schema.sql`); `GetActiveRuleSet`,
  `LookupSpecies`, `ValidateGtin` (`BACKEND §2.1`). `uq_ruleset_one_active` partial unique index.
  Ingestion validates against a **versioned snapshot** (no live coupling, `BACKEND §8.2.4`).
- **Invariants to preserve:** dependency-direction law (Ingestion reads a snapshot, does not import
  Compliance domain — `ARCHITECTURE §2.2/§5.3`); historical immutability (an alert/confirm is
  explainable by the rule-set version in force, `schema.sql extraction_run.rule_set_version`).
- **Validation criteria:** test that at most one rule-set is active (`uq_ruleset_one_active`);
  eval **E12/E13** controlled-vocab discipline (out-of-vocab kept + flagged, never guessed). G-ARCH,
  G-MIG. **B2 is the data input here — routed to owner, not invented (§6).**
- **Rollback strategy:** reference data is additive/versioned; deactivate a rule-set version (set
  `is_active=false`) — never mutate history. Redeploy-previous-image. Reversible.

#### Step 5.2 — Traceability: suppliers, products, batches + `BatchRegistered`
- **Scope:** `contexts/traceability/` (layered): `traceability.supplier`/`product`/`batch` tables
  (`schema.sql`); `RegisterBatch` from `ExtractionConfirmed` (async) or `POST /v1/batches`
  (manual); GTIN GS1 checksum (`BACKEND §8.4`); `lot_code` unique per supplier+product
  (`uq_batch_lot`); `source_ingestion_id` by-ID provenance (`SYNTHESIS.md §5` step 10).
  Supplier CRUD with `If-Match` ETag + soft-deactivate (`BACKEND §4.5`).
- **Invariants to preserve:** dependency-direction law (cross-context via `BatchRegistered` event +
  by-ID refs, **no cross-context FK/import** — `SYNTHESIS.md §4.4`); append-only audit (batch create
  co-commits audit); idempotency (batch/supplier create require key); correlation_id/trace_id.
- **Validation criteria:** integration test ExtractionConfirmed→BatchRegistered→batch row; EXPLAIN-
  ANALYZE the by-lot trace covering index `idx_batch_lot_cover` is used (`schema.sql`,
  `DATABASE §4.1`); `422 GTIN_CHECKSUM_INVALID`/`LOT_CODE_DUPLICATE` paths (`BACKEND §5.2`). G-AUDIT,
  G-ARCH. SLO-2b read latency for trace.
- **Rollback strategy:** new context additive; batch creation is additive. Redeploy-previous-image.
  Reversible.

#### Step 5.3 — HACCP: control plans, temperature logs, alerts, monitoring
- **Scope:** `contexts/haccp/` (hexagonal): `haccp.control_plan` (versioned, immutable once active),
  `haccp.temperature_log` (append-only, built in PG-1 trigger-protected; writer here),
  `haccp.alert` tables (`schema.sql`); `POST /v1/temperature-logs`; expiry monitoring on
  `BatchRegistered`/scheduled scan; temperature monitoring on `TemperatureLogged`; alert lifecycle
  `open→acknowledged→resolved` (`SYNTHESIS.md §5` steps 11–12, `BACKEND §3.G/§3.H`).
- **Invariants to preserve:** historical immutability (temperature_log append-only — PG-1 trigger);
  append-only audit (every alert transition + temp log co-commits audit, `ARCHITECTURE §7.6`);
  dependency-direction law (HACCP references batches by ID, consumes events); correlation_id/trace_id.
- **Validation criteria:** integration: temp breach → `TemperatureThresholdBreached` → alert `open`;
  EXPLAIN-ANALYZE `idx_batch_use_by` partial index used by expiry scan, `idx_alert_open` by the
  worklist (`schema.sql`, `DATABASE §4.3–§4.5`); `409 ALERT_INVALID_TRANSITION` (`BACKEND §5.2`);
  scheduled-scan **dead-man's-switch** heartbeat (`SRE §10`). G-AUDIT (alert transitions). E08
  (Fahrenheit → correct Celsius drives correct HACCP signal).
- **Rollback strategy:** alerting enabled **per control** (`BACKEND §11.4` Phase 4); read APIs side-
  effect-free. Control-plan **authoring** has no management endpoint (`SYNTHESIS.md §6` note — flagged,
  not invented here). Redeploy-previous-image. Reversible.

---

### PG-6 — API exposure + thin-client cutover (ARCHITECTURE §9 Phase 4→5)

#### Step 6.1 — Auth scopes + RBAC enforcement across all `/v1` endpoints
- **Scope:** `platform/http/middleware.py` JWT/JWKS verification (RS256, `BACKEND §6.1`), fail-closed
  per-route scope checks (`BACKEND §6.3`); RBAC roles (`scanner-device`, `fishmonger`, `supervisor`,
  `auditor`, `admin`, `BACKEND §6.2`); read endpoints for trace/alerts/audit/temperature-logs
  (`SYNTHESIS.md §6`).
- **Invariants to preserve:** append-only audit (authorization denials logged as security events;
  business actions carry `actor`); dependency-direction law; correlation_id/trace_id.
- **Validation criteria:** auth tests (auditor read-only cannot mutate by construction;
  scanner-device `ingestion:write` only); endpoint with no declared scope fails closed
  (`BACKEND §6.3`); G-EVAL contract tests for all `/v1`. **B6 (API↔contract name alignment deltas
  D1–D7) lands here** — mechanical enum/name alignment (§6). SLO-2b read latency.
- **Rollback strategy:** middleware additive; scopes config-driven. Redeploy-previous-image.
  Reversible.

#### Step 6.2 — Expo strangler dual-write → thin-client cutover (Phase 5, LAST)
- **Scope:** Mobile app gains a durable offline queue → `POST /v1/ingestions` with `Idempotency-Key`;
  drops the bundled Vision key (R7 fully fixed); history/list/export read from backend APIs; AsyncStorage
  becomes a local cache/outbox (`ARCHITECTURE §9 Phase 5`, `BACKEND §11.4`). Capture UI kept/repurposed.
- **Invariants to preserve:** raw-before-normalized (server stores raw on submit); idempotency
  (durable-queue retries reuse the key — guardrail prevents duplicates); correlation_id/trace_id
  (client supplies/propagates `X-Correlation-Id`).
- **Validation criteria:** synthetic black-box probe — a canary capture flows submit→extract→appears
  in lookup (`SRE §10` synthetic probes); E24 replay from the durable queue; G-DUR 100% on real
  traffic. SLO-1 availability through the cutover.
- **Rollback strategy:** **strangler keeps AsyncStorage as cache/outbox** so a backend outage degrades
  to offline-queued capture, not loss (`BACKEND §11.4` Phase 5); feature-flag the cutover; the legacy
  local path is removed **only after** the backend path is proven. **Flagged: this is the highest-blast-
  radius step** — gate it last, behind canary + G-DUR. Reversible via flag.

---

## 4. Dependency & sequencing graph (textual DAG)

```
PG-0.1 (skeleton+middleware)
   └─▶ PG-0.2 (ports)
          └─▶ PG-1.1 (schemas) ─▶ PG-1.2 (append-only DDL+triggers)  ◀── HARD PREREQUISITE GATE
                                        │   (no writer may precede this; §1.2)
                                        ├─▶ PG-1.3 (AuditLogPort)
                                        └─▶ PG-1.4 (idempotency/outbox tables)
   PG-1.2 ∧ PG-1.3 ∧ PG-1.4 ─▶ PG-2.1 (ingestion agg + raw repo)
                                  └─▶ PG-2.2 (POST /ingestions, 202, same-txn audit+outbox)
                                         ├─▶ PG-2.3 (ingestion reads)            [parallel-OK]
                                         └─▶ PG-3.1 (outbox dispatcher)
                                                └─▶ PG-3.2 (worker shell)
                                                       └─▶ PG-4.1 (OCR adapter+quality gate)
                                                              └─▶ PG-4.2 (LLM adapter)
                                                                     └─▶ PG-4.3 (no-fabrication gate)  ◀ TRUST BOUNDARY
                                                                            └─▶ PG-4.4 (routing + HITL)
PG-1.1 ─▶ PG-5.1 (compliance rule-set/vocab)  [parallel with PG-2..PG-4, needs schemas only]
PG-4.4 ∧ PG-5.1 ─▶ PG-5.2 (traceability/batches)
PG-5.2 ─▶ PG-5.3 (HACCP/alerts)
(PG-2.2 ∧ PG-4.4 ∧ PG-5.2 ∧ PG-5.3) ─▶ PG-6.1 (auth + all /v1 exposure)
PG-6.1 ─▶ PG-6.2 (thin-client cutover)   ◀ LAST, highest blast radius
```

**Critical path:** `0.1 → 0.2 → 1.1 → 1.2 → (1.3,1.4) → 2.1 → 2.2 → 3.1 → 3.2 → 4.1 → 4.2 → 4.3 →
4.4 → 5.2 → 5.3 → 6.1 → 6.2`.

**Safe parallelism (without violating boundaries):**
- PG-5.1 (compliance) needs only PG-1.1 schemas → can proceed alongside PG-2..PG-4 (it is read-only
  reference data; the gate consumes a snapshot, `BACKEND §8.2.4`). **B2 owner work runs in parallel.**
- PG-2.3 (ingestion reads) parallel with PG-3 (read-only, no extraction dependency).
- PG-1.3 and PG-1.4 are independent of each other (both depend only on PG-1.2 / PG-1.1).
- **Never parallel:** any PG-2+ writer before PG-1.2 (append-only) and PG-1.3 (audit path) — that is
  the SLO-3 stop-rule (§6 STOP-1).

---

## 5. Verification & promotion strategy per phase-group

Promotion uses **G-SLO** (canary 5% → 25% → 50% → 100%, `SRE §7.1`); a stage cannot promote while a
relevant SLO is in freeze (`SRE §2.3`). SLO-3 is **un-budgeted** — any breach auto-freezes (`SRE §2.2`).

| PG | Entry criteria | Exit / promotion criteria |
|----|----------------|----------------------------|
| **PG-0** | repo + CI runner available | G-ARCH green on the skeleton; health endpoints up; ports compile against fakes. |
| **PG-1** | PG-0 done | Trigger-violation tests pass on all 3 append-only tables; G-AUDIT harness co-commits exactly one row; idempotency replay unit tests pass; G-MIG (expand reversible) green; partition-pruning EXPLAIN confirmed. **No PG-2 work starts until this exits.** |
| **PG-2** | PG-1 exited | G-DUR shows **100%** SLO-3a on canary; E02/E24 pass; submit-path-makes-no-provider-call test passes; SLO-1 ≥99.9% and SLO-2a p95<1.5s on canary; `ingestion.fail_closed` kill-switch verified. |
| **PG-3** | PG-2 exited | Exactly-effectively-once dispatch + DLQ verified; trace stitches across the hop; worker dead-man's-switch firing on simulated death; outbox depth/age signal green. |
| **PG-4** | PG-3 exited | G-EVAL **hard gates 100%** (SC1/SC3/SC10, E04/E05/E14/E15/E20/E22/E23/E24); soft gates no-regress ×3 runs; `evidence_gate_reject` detector live; SLO-4a ≥99% terminal, ≥95% good; SLO-4b p95<60s. |
| **PG-5** | PG-4 exited; **B2 rule-set authored** | **Validation rule-set runs warn-only first** (`BACKEND §8.3`, `eval-suite §4`), then flip to **enforce** only after warn-only telemetry shows the threshold isn't flooding review (E19). Trace covering-index EXPLAIN confirmed; scheduled-scan dead-man's-switch live; G-AUDIT on alert transitions. |
| **PG-6** | PG-5 exited | All `/v1` contract tests pass; fail-closed scope tests pass; **B6 deltas D1–D7 applied** so API == extraction.v1/`schema.sql` names; synthetic end-to-end probe green; G-DUR 100% on real traffic before the thin-client cutover is promoted to 100%. |

**Warn-only → enforce rollout (validation rule-set):** the `eval-suite` runs identically in both
modes; only the routing assertion (block vs warn) differs (`eval-suite §4`). Enforce mode is gated on
B2 being authored and on warn-only telemetry, per `ARCHITECTURE §9 Phase 3` reversibility.

---

## 6. Risk register & STOP flags

### 6.1 Ordering / SLO-3 STOP flags (with corrective re-ordering)

| ID | Risk (ordering) | Why it threatens SLO-3 / boundaries | Corrective action (STOP rule) |
|----|------------------|--------------------------------------|-------------------------------|
| **STOP-1** | Any PG-2+ **writer introduced before PG-1.2 (append-only DDL) + PG-1.3 (audit path)**. | A writer without DB-level immutability can mutate history (SLO-3b/guardrail b); a writer without the audit path can write un-audited (SLO-3b/guardrail a). | **STOP.** Re-order: PG-1.2 and PG-1.3 are a hard prerequisite gate (§4); no writer step may start until they exit (§5 PG-1 exit). Already sequenced this way — flagged so it stays so. |
| **STOP-2** | Ingestion **acking (202) before durable raw storage** (e.g. async PUT, or PUT after 202). | Breaks SLO-3a — a 202 is a promise of durability (`SRE §1`). | **STOP.** PG-2.2 must store raw (object store + `raw_artifact`) **before** 202 (`SYNTHESIS.md §5` step 1); on PUT failure return `503` (`ingestion.fail_closed`, `SRE §7.3` RB-2), never ack-without-durability. G-DUR enforces in canary. |
| **STOP-3** | Ingestion calling **OCR/LLM inline** (synchronous coupling). | Couples capture availability to providers; a provider outage blocks capture (the one thing that must never lose data, `BACKEND §1.2`). | **STOP.** The outbox/worker boundary (PG-3) must exist; PG-2 submit enqueues only. G-ARCH forbids the ingestion HTTP adapter importing extraction adapters; submit-makes-no-provider-call test (guardrail c). |
| **STOP-4** | Disabling the **no-fabrication gate** (PG-4.3) as a "rollback" to ship faster. | Removes the trust boundary — fabricated/hallucinated fields enter the record (constraint #1). | **STOP.** PG-4.3 rollback may only revert to a prior **correct** gate version, never to "no gate" (§3 Step 4.3). Eval E14/E15 are hard gates (`eval-suite §3`). |
| **STOP-5** | Expand **and** contract a schema in the **same release**. | Contract is not safely reversible (`SRE §7.2`); rolling back to old code that needs the old shape becomes impossible. | **STOP.** G-MIG rejects expand+contract in one release; sequence so rollback never needs the old shape (`BACKEND §11.2`, migrations `0001` expand / `0002` index). |

### 6.2 Carried BLOCKERs B1–B6 (from SYNTHESIS §8) — routed to owners + the step where each must resolve

**These are inputs to be resolved by their owners, NOT invented in this plan.** All
NEEDS-VERIFICATION / NEEDS-CONFIRMATION flags are preserved.

| # | Carried flag | Owner | Resolve by / lands at | Consequence if unresolved |
|---|--------------|-------|------------------------|---------------------------|
| **B1** | 15 vs 16 stored `extracted_field` rows (confirm 15 + run-level `raw_warnings`). | Product/Compliance | **Before PG-4.3** (the gate persists 15 rows; `schema.sql` CHECK encodes 15). | If "16 rows" is mandated, a one-line `extracted_field` CHECK change (expand-and-contract) is needed before PG-4.3 enforce. |
| **B2** | Required-field rule-set **contents** (which of 15 mandatory + thresholds). | Compliance | **Authored/versioned before PG-5 enforce mode** (warn-only runs without it). | Validation gate cannot run in enforce mode (`BACKEND §8.3`); stays warn-only until authored. |
| **B3** | Retention window + GDPR-vs-immutability erasure approach. | Legal/Compliance | **Before go-live** (informs PG-1 partitioning retention + object-store purge policy, `DATABASE §7`, `BACKEND S2`). | Retention/purge policy undefined; append-only store grows unbounded; PII handling unresolved. |
| **B4** | Audit hash-chain external anchoring (enable + where to anchor). | Security/Compliance | **Optional hardening** on top of PG-1.3 (grants+trigger is the mandatory floor; chain columns nullable). | None to the floor; chaining stays off until decided (`SYNTHESIS.md` C8). |
| **B5** | Capacity & provider rate limits (replace ASSUMED `SRE §8` numbers; confirm `claude-haiku-4-5` (default) RPM/TPM, plus `claude-opus-4-8` for the escalation tier). | SRE | **Before go-live sizing** (2–4 wk baseline, `SRE §1` calibration); informs PG-4 breaker/rate-limit tuning. | Go-live sizing is guesswork; SLO targets stay "initial," not contractual. |
| **B6** | API↔contract name-alignment deltas **D1–D7** (enum/name fixes to match extraction.v1/`schema.sql`). | Backend Architect | **At PG-6.1** (mechanical; touches published OpenAPI/API-CONTRACTS). | API read-model drifts from the stored contract (e.g. `FieldName` enum, `production_method`, `Provenance.source`); breaks override→column mapping. |

### 6.3 Other risks (non-ordering)

- **Worker silent death** (extraction stops while ingestion still 202s) → mitigated by the worker
  dead-man's-switch (`SRE §10`, PG-3.2).
- **Scheduled-scan silent death** (suppressed food-safety alerts) → dead-man's-switch on the scan
  heartbeat (`SRE §10`, PG-5.3).
- **Control-plan authoring has no management endpoint** (`SYNTHESIS.md §6`/§7 note) — flagged as a
  later-phase item; alerts are system-raised, plan CRUD was deliberately deferred. Not invented here.

---

## 7. Out of scope / explicitly NOT in this plan

This is **planning only**. Reaffirmed:

- **No code.** No implementation is written; all artifacts referenced by `file:§`.
- **No new features, endpoints, tables, fields, or events.** Everything maps to existing
  `SYNTHESIS.md §4/§5/§6`, `schema.sql`, `BACKEND §3`, `ARCHITECTURE §6` artifacts.
- **No new design decisions.** Conflicts were already resolved in `SYNTHESIS.md §2`; this plan does
  not revisit them.
- **B1–B6 are NOT resolved here** — they are routed to their owners (§6.2) and the step where each
  must land. All NEEDS-VERIFICATION / NEEDS-CONFIRMATION flags are preserved.
- **Not in scope:** sibling projects (FishTrac, TRACEO, TRACEO1); the actual EU regulatory rule-set
  contents (B2, Compliance-owned data); concrete capacity numbers (B5, SRE-owned measurement);
  control-plan authoring API (deferred per `SYNTHESIS.md §6`).
```
