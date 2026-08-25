# LabelScan — Database Design

**Status:** Implemented; `server/migrations/` is the source of truth for the current revision.
**Date:** 2026-06-18 (updated from 2026-06-14 design)
**Author:** Database Optimizer
**Target engine:** PostgreSQL 16. Assumes the `pgcrypto` extension (`gen_random_uuid()`, hashing).
**Scope:** `LabelScan/` only. Sibling projects out of scope.

> This document **builds on and does not contradict** the existing design. Read first:
> [`../ENTERPRISE-ARCHITECTURE.md`](../ENTERPRISE-ARCHITECTURE.md),
> ADR-0003/0004/0005, [`../backend/BACKEND-ARCHITECTURE.md`](../backend/BACKEND-ARCHITECTURE.md)
> (§7 idempotency, §2.3 outbox, §11 expand-and-contract),
> [`../extraction/schema/extraction.v1.schema.json`](../extraction/schema/extraction.v1.schema.json),
> [`../pipeline/shared-state.schema.json`](../pipeline/shared-state.schema.json), and
> [`../ai-pipeline/AI-PIPELINE.md`](../ai-pipeline/AI-PIPELINE.md) §4 (composite confidence).
> The DDL is the companion file [`schema.sql`](./schema.sql); illustrative migrations are in
> [`migrations/`](./migrations/). Keep all three in sync.

**A note on field count (trade profile V2 / prompt v3.0.0).** The runtime LLM emits **16 fields** —
`commercial_designation`, `scientific_name`, `producer_name`, `reseller_brand`, `batch_number`,
`origin_country`, `FAO_area`, `production_method`, `fishing_gear_or_farming_method`, `expiry_date`,
`packaging_date`, `storage_temperature`, `allergens`, `health_mark`, `weight`, plus `gtin`
(set from GS1 AI 01). Profile V2 retires `price`; V1 remains readable for immutable history. v2 dropped `product_name` (`commercial_designation`
is now THE designation), split `supplier_name` into `producer_name`/`reseller_brand`, and added
`health_mark` (estampille sanitaire). The `extracted_field.field_name` CHECK is a **SUPERSET**
(migration 0011): it still also allows the legacy `product_name`/`supplier_name` so the append-only
immutable historical rows stay valid. The label-level `raw_warnings` is stored on
`extraction_run.raw_warnings`.

---

## 1. SQL schema

Full DDL lives in [`schema.sql`](./schema.sql). This section explains the shape and the choices;
it does not re-paste the DDL except where the exact text is load-bearing.

### 1.1 Schema-per-context layout (module boundaries visible at the DB level)

One PostgreSQL `SCHEMA` per bounded context (ARCHITECTURE §2), plus a `platform` schema for
cross-cutting infra:

| Schema | Context (ARCHITECTURE §2) | Tables |
|--------|---------------------------|--------|
| `ingestion` | (1) Label Ingestion & Extraction (CORE) | `raw_artifact` (append-only, partitioned), `ingestion`, `extraction_run`, `extracted_field` |
| `compliance` | (2) Compliance & Catalog | `required_field_rule_set`, `species`, `fao_area` |
| `traceability` | (3) Traceability Registry | `supplier`, `product`, `batch` |
| `haccp` | (4) HACCP Controls & Alerting (CORE) | `control_plan`, `temperature_log` (append-only, partitioned), `alert` |
| `audit` | (5) Audit & History | `audit_log` (append-only, partitioned, hash-chained) |
| `identity` | (6) Identity & Access | `actor`, `app_user` (credential store, migration 0007) |
| `platform` | cross-cutting infra | `idempotency_key`, `processed_event`, `outbox`, `deny_mutation()` trigger fn |

### 1.2 Cross-context reference policy (the explicit call-out the brief asks for)

**Foreign keys exist only *within* a schema. Cross-context links are plain indexed `uuid`
columns, never `FOREIGN KEY`s.** Justification, tied to the architecture's dependency rules
(ARCHITECTURE §5.3 — "a context never imports another context's domain; integration is via
published events"):

- A cross-schema FK would re-introduce exactly the compile-/run-time coupling the architecture
  forbids: it would make `traceability` physically depend on `ingestion`'s table and lifecycle.
- It would couple **migrations and locking** across contexts (an `ALTER` on the parent can lock the
  child), defeating "migrations scoped to one context" (BACKEND §11.2).
- It would block a future **extract-to-service along a seam** (ADR-0001 reversibility) — you cannot
  move `haccp` to its own database if it has a hard FK into `traceability`.

Concrete cross-context columns (each documented with a `COMMENT` naming its logical target):

| Column | Logical target | Validated by |
|--------|----------------|--------------|
| `ingestion.extraction_run.raw_ocr_artifact_id` | `ingestion.raw_artifact.id` (same context, but parent is **partitioned** so no FK — see §1.4) | app |
| `traceability.batch.source_ingestion_id` | `ingestion.ingestion.id` | event `ExtractionConfirmed`/`BatchRegistered` + app |
| `traceability.product.species_id` | `compliance.species.id` | app / vocab check |
| `haccp.temperature_log.batch_id` | `traceability.batch.id` | app |
| `haccp.alert.batch_id` | `traceability.batch.id` | event `BatchRegistered` + app |
| `audit.audit_log.actor_id`, `*.submitted_by`, `*.acknowledged_by` | `identity.actor.id` | app/token |

**Intra-context FKs that *do* exist** (and are all indexed, §2): `extraction_run.ingestion_id →
ingestion.ingestion`, `extracted_field.extraction_run_id → extraction_run`,
`batch.supplier_id → supplier`, `batch.product_id → product`.

### 1.3 How the 15 fields are stored — typed `extracted_field` table + JSONB value

**Decision: a typed `extracted_field` table, one row per (run, field), with a polymorphic JSONB
`value` and *typed* columns for the uniform provenance/quality attributes.** This is the
queryability-vs-flexibility trade-off named explicitly:

- The **value shapes are heterogeneous** across the fields (a plain string for `commercial_designation`;
  `{raw, iso_3166_1_alpha2}` for `origin_country`; `{kind, celsius_min, celsius_max, original}` for
  `storage_temperature`; an array for `allergens`; `{amount, unit, basis, ...}` for `weight`). A
  fixed typed SQL column per field would mean 15 sparse, mostly-null columns and a schema change for
  every contract revision. So the **normalized value is JSONB** (`extracted_field.value`) — flexible,
  versionable with the extraction schema.
- The **provenance/quality attributes are uniform** for every field — `confidence` (three component
  scores + combined + band), `evidence`, `validation_status`, `warnings`, `source`, `source_ref`.
  These get **real typed, indexable columns**, so set-based questions like "all required fields below
  the review band for this run" or "every `ambiguous`/`invalid` field" are a single indexed query
  (partial index `idx_extracted_field_low_conf`), not a JSONB scan.
- The **few attributes HACCP actually filters on** — `use_by`, `packaging_date`,
  `production_method`, `gtin`, `species` — are **projected as typed columns on
  `traceability.batch`** at confirm time, where the range/expiry scans run. This keeps the hot
  HACCP/trace queries off JSONB entirely.

Confidence is stored per AI-PIPELINE §4: `llm_confidence` (the recalibrated model hint),
`ocr_confidence` (the OCR floor over the evidence span), `combined_confidence` (the gate-owned
composite), and `confidence_band` (the `Confidence` VO band that thresholds/routing use). Storing all
four makes "how confident, and **why**" answerable from the row alone (§4.1 component signals).

**Trade-off (named):** typed rows + JSONB value buys per-field indexing on confidence/status/name and
a stable schema as fields evolve; it gives up direct SQL type-checking of the polymorphic `value`
(enforced instead by the LLM-output gate, BACKEND §8.2, and the extraction schema). The rejected
alternative — one JSONB blob per run — would lose all per-field indexing and force application-side
filtering of the review worklist. See §9.

### 1.4 Immutability & append-only shape

`raw_artifact`, `audit_log`, `temperature_log` are **append-only**: write-once, never updated or
deleted (ADR-0003/0004; ARCHITECTURE §7.2/§7.7). They are **`PARTITION BY RANGE` on their
server-stamped timestamp** for retention and pruning (§7). Because PG cannot place a FK from a
partitioned table's child onto these (and we want immutability independent of the mutable
`ingestion` lifecycle, ARCHITECTURE §7.2), references *into* them are logical `uuid`s.

Corrections never overwrite: a re-extraction creates a **new `extraction_run`** and flags the prior
one `is_superseded = true` (never deletes it); a human field override inserts a **new
`extracted_field`** row (`source = 'human'`) and links the original via `superseded_by_field_id`
(original retained — ADR-0005). Both remain queryable.

### 1.5 Types, constraints, GTIN

- **uuid PKs** (`gen_random_uuid()` default); the app should supply UUIDv7/ULID for the high-volume
  append-only tables (§8). **`timestamptz`** everywhere; server time is authoritative,
  `client_captured_at` is stored as *claimed* only (BACKEND S11 / AUDIT D9).
- **`numeric`** for money/temperature/confidence (`temp_c numeric(5,2)`, `*_confidence
  numeric(4,3)`) — never float, to avoid rounding drift in a compliance system.
- **`jsonb`** for raw OCR (`raw_artifact.raw_json`), the polymorphic field `value`/`evidence`,
  rule-set/threshold/alert detail.
- **CHECK** constraints encode the closed enums (statuses, `validation_status`, bands,
  `production_method`), the **no-fabrication invariant** (`evidence` present **iff** `value`
  present), and a **GTIN shape** check (`^[0-9]{8}$|^[0-9]{12,14}$`); the full GS1 **check-digit**
  validation is the app's job (BACKEND §8.4) — a CHECK cannot compute it portably, and we must not
  *invent* validity.
- **UNIQUE**: `actor.subject`, `supplier`-scoped `batch.lot_code` (`(supplier_id, product_id,
  lot_code)`), `product.gtin`, one-active partial uniques on rule-set/control-plan, and the
  content-addressed `(ingestion_id, artifact_kind, checksum_sha256)` on `raw_artifact`.

---

## 2. Index strategy

Principles: **PK on every table; every FK has a supporting index; lookup indexes on the real read
paths; partial indexes for hot small subsets; GIN only where JSONB is actually queried; composite/
covering indexes for the critical joins.** Write-amplification trade-off noted at the end.

| Table | PK / unique | FK indexes | Lookup / partial / GIN / covering |
|-------|-------------|-----------|-----------------------------------|
| `ingestion.raw_artifact` | PK `(id, occurred_at)`; **unique** `(ingestion_id, artifact_kind, checksum_sha256)` (idempotent append) | `idx_raw_artifact_ingestion (ingestion_id)` | `idx_raw_artifact_correlation`; **GIN** `idx_raw_artifact_json_gin (raw_json jsonb_path_ops) WHERE artifact_kind='ocr_json'` (only if OCR JSON is queried) |
| `ingestion.ingestion` | PK `id` | `idx_ingestion_submitted_by` | `idx_ingestion_status_received (status, server_received_at DESC)`; `idx_ingestion_barcode WHERE barcode_raw IS NOT NULL`; **partial** `idx_ingestion_needs_review WHERE status='needs_review'` |
| `ingestion.extraction_run` | PK `id` | `idx_extraction_run_ingestion (ingestion_id, created_at DESC)` | **partial** `idx_extraction_run_current (ingestion_id) WHERE NOT is_superseded` (the "latest run" read) |
| `ingestion.extracted_field` | PK `id` | `idx_extracted_field_run (extraction_run_id)`; `idx_extracted_field_override_chain` | `idx_extracted_field_run_name (run_id, field_name)`; **partial** `idx_extracted_field_low_conf ... WHERE confidence_band='low' OR validation_status IN ('ambiguous','invalid','missing')` (review worklist) |
| `traceability.supplier` | PK `id` | — | `idx_supplier_name`; **partial** `idx_supplier_active WHERE is_active` |
| `traceability.product` | PK `id`; unique `gtin` | `idx_product_species` | (gtin already indexed by unique) |
| `traceability.batch` | PK `id`; unique `(supplier_id, product_id, lot_code)` | `idx_batch_supplier`, `idx_batch_product`, `idx_batch_source_ingestion` (logical FK) | `idx_batch_lot_code`; `idx_batch_gtin WHERE gtin IS NOT NULL`; **partial** `idx_batch_use_by WHERE use_by IS NOT NULL`; **covering** `idx_batch_lot_cover (lot_code) INCLUDE (gtin, supplier_id, product_id, use_by, source_ingestion_id)` |
| `haccp.control_plan` | PK `id`; unique `version` | — | **partial** `uq_control_plan_one_active WHERE is_active` |
| `haccp.temperature_log` | PK `(id, recorded_at)` | `idx_templog_batch (batch_id) WHERE batch_id IS NOT NULL` | `idx_templog_location_time (location, recorded_at DESC)`; `idx_templog_measured` |
| `haccp.alert` | PK `id` | `idx_alert_batch WHERE batch_id IS NOT NULL` | `idx_alert_type_state (type,state,raised_at DESC)`; **partial** `idx_alert_open WHERE state='open'`; **partial** `idx_alert_open_by_location WHERE state='open' AND location IS NOT NULL` |
| `audit.audit_log` | PK `(id, occurred_at)` | `idx_audit_actor (actor_id, occurred_at DESC)` (logical FK) | `idx_audit_subject`, `idx_audit_action`, `idx_audit_correlation` |
| `platform.idempotency_key` | PK `scope_hash` | — | `idx_idempotency_expires (expires_at)` (TTL sweep) |
| `platform.processed_event` | PK `(consumer, event_id)` | — | — |
| `platform.outbox` | PK `event_id` | — | **partial** `idx_outbox_undispatched (occurred_at) WHERE dispatched_at IS NULL` (dispatcher poll) |

**Fast traceability lookup index path.** By-lot: `idx_batch_lot_code` (or the covering
`idx_batch_lot_cover` for the common projection) → resolve `supplier_id`/`product_id` via their PKs
→ `batch.source_ingestion_id` → `ingestion.ingestion` PK → `raw_artifact` via
`idx_raw_artifact_ingestion` and the run via `idx_extraction_run_current`. By-GTIN:
`idx_batch_gtin`. By-supplier: `idx_batch_supplier`. (Full query in §4.1.)

**Write-amplification trade-off (explicit).** Every index is paid for on every `INSERT`/`UPDATE` of
its table. On the **append-only high-volume** tables (`temperature_log`, `audit_log`, `raw_artifact`)
we deliberately keep indexes lean and mostly **partial** (only the hot subset) — e.g. we index
`temperature_log` by `(location, recorded_at)` and `batch_id` but do **not** add speculative indexes,
because each one multiplies insert cost on the hottest write path. Partial indexes (`WHERE
state='open'`, `WHERE use_by IS NOT NULL`, `WHERE dispatched_at IS NULL`) are both **smaller** and
**cheaper to maintain** than full indexes, since rows outside the predicate never touch them.

---

## 3. Audit immutability strategy

Goal: make "we didn't tamper / didn't invent" a **DB-level guarantee**, not a code convention
(ADR-0003/0004, BACKEND S8). Enforced in layers; each layer's value is named.

### 3.1 Privilege layer — `REVOKE UPDATE/DELETE` from the app role
The runtime role `labelscan_app` is granted only `INSERT, SELECT` on `raw_artifact`, `audit_log`,
`temperature_log`; `UPDATE, DELETE, TRUNCATE` are **revoked**. *Buys:* the common, accidental path
(an ORM `UPDATE`, a bug, a careless query) is structurally impossible for the app. *Limit:* a
superuser or a mis-granted role could still mutate — hence layer 2.

### 3.2 Trigger layer — `BEFORE UPDATE OR DELETE ... RAISE`
`platform.deny_mutation()` is a `BEFORE UPDATE OR DELETE` row trigger on each append-only table that
`RAISE EXCEPTION ... USING ERRCODE='insufficient_privilege'`. *Buys:* defence in depth — even a role
that *does* hold UPDATE/DELETE (e.g. the maintenance role, or a future misconfiguration) is blocked
at the row level. In PG 16 a `BEFORE ROW` trigger on a partitioned parent **propagates to all
current and future partitions**, so retention/new monthly partitions stay protected automatically.
*Limit:* a superuser can `ALTER TABLE ... DISABLE TRIGGER`; that action itself should be alertable
(§10.5 backend "audit-write failures / page immediately").

### 3.3 Protecting `raw_artifact` and `audit_log` specifically
- `raw_artifact`: the binary never enters the DB (object store; only a content-addressed key +
  `checksum_sha256`), and the `(ingestion_id, artifact_kind, checksum_sha256)` unique key means a
  re-submit of identical bytes **cannot double-append** (idempotency without mutation — BACKEND
  §7.4). Re-processing produces a *new* `ocr_json` artifact row, never an edit.
- `audit_log`: there is **no write API** (BACKEND §4.9 returns `405`); it is written only via the
  internal `AuditLogPort`, in the **same transaction** as the business change, so no business write
  exists without its audit row.

### 3.4 Tamper-evidence — optional hash chaining (trade-offs)
`audit_log` carries `prev_hash` and `entry_hash` columns. Each entry's `entry_hash =
H(prev_hash || canonical(row payload))`, where `prev_hash` is the previous entry's hash (a Merkle/
blockchain-style chain). *Buys:* tamper-**evidence** — any after-the-fact edit or deletion (e.g. by a
DBA who bypassed the triggers) breaks the chain and is **detectable** by a verifier job. *Costs &
caveats, named:*
- It is tamper-**evident**, not tamper-**proof** — an attacker who can rewrite rows can also recompute
  the chain *unless* the chain head is periodically anchored externally (e.g. signed and shipped to
  WORM storage / a notary). That external anchor is the real integrity root; flagged as a policy
  decision, not fabricated here.
- Chaining serialises audit appends within a partition (each needs the prior hash). Mitigation: chain
  per-partition (per time bucket) and anchor partition heads, trading a single global chain for
  parallelism — a reversible choice.

### 3.5 App-level vs DB-level — what each buys
- **App-level** (use cases always write an audit row, `ConfirmExtraction` creates a new run not an
  overwrite): buys *semantic* correctness and rich domain meaning, but erodes under bugs/shortcuts
  (exactly AUDIT D4's failure mode).
- **DB-level** (grants + triggers + unique-checksum + hash chain): buys an *enforced* guarantee that
  survives application bugs and is provable to an auditor. We use **both**; DB-level is the backstop
  the compliance posture rests on.

---

## 4. Critical queries

Real read paths as concrete SQL. **No `SELECT *`.** Each notes its expected index usage.

### 4.1 Traceability lookup by lot/batch → full chain
```sql
-- batch -> supplier -> product -> source ingestion -> raw artifact(s) + current extraction fields
SELECT b.id              AS batch_id,
       b.lot_code,
       b.gtin,
       b.use_by,
       b.production_method,
       s.id              AS supplier_id,
       s.name            AS supplier_name,
       s.approval_number,
       p.id              AS product_id,
       p.name            AS product_name,
       i.id              AS ingestion_id,
       i.server_received_at,
       er.id             AS extraction_run_id,
       er.extractor_version
FROM traceability.batch b
LEFT JOIN traceability.supplier s ON s.id = b.supplier_id
LEFT JOIN traceability.product  p ON p.id = b.product_id
-- cross-context: by-ID join, no FK (validated upstream by events)
JOIN ingestion.ingestion i ON i.id = b.source_ingestion_id
LEFT JOIN ingestion.extraction_run er
       ON er.ingestion_id = i.id AND NOT er.is_superseded
WHERE b.lot_code = $1;
```
*Index usage:* `idx_batch_lot_code` (or `idx_batch_lot_cover` index-only for the batch columns) →
`supplier`/`product` PKs → `ingestion.ingestion` PK on `source_ingestion_id` →
`idx_extraction_run_current` for the non-superseded run. To pull the per-field values for that run,
a second set-based query (avoids N+1):
```sql
SELECT ef.field_name, ef.value, ef.combined_confidence, ef.confidence_band, ef.validation_status
FROM ingestion.extracted_field ef
WHERE ef.extraction_run_id = $1
  AND ef.superseded_by_field_id IS NULL;   -- current (non-overridden) values only
```
*Index usage:* `idx_extracted_field_run` / `idx_extracted_field_run_name`.

### 4.2 Ingestion / extraction status
```sql
SELECT i.id, i.status, i.server_received_at,
       er.id AS run_id, er.outcome, er.extractor_version, er.mean_token_confidence
FROM ingestion.ingestion i
LEFT JOIN ingestion.extraction_run er
       ON er.ingestion_id = i.id AND NOT er.is_superseded
WHERE i.id = $1;
```
*Index usage:* PK on `ingestion`, `idx_extraction_run_current`.

### 4.3 Open alerts for a location / batch
```sql
SELECT a.id, a.alert_type, a.severity, a.batch_id, a.location,
       a.control_plan_version, a.raised_at
FROM haccp.alert a
WHERE a.state = 'open'
  AND ($1::uuid IS NULL OR a.batch_id = $1)
  AND ($2::text IS NULL OR a.location = $2)
ORDER BY a.severity DESC, a.raised_at DESC
LIMIT 100;
```
*Index usage:* partial `idx_alert_open` / `idx_alert_open_by_location` (only open rows scanned).

### 4.4 Expiry-window scan
```sql
SELECT b.id, b.lot_code, b.use_by, b.supplier_id, b.product_id
FROM traceability.batch b
WHERE b.use_by IS NOT NULL
  AND b.use_by <= ($1::date + INTERVAL '3 days')   -- "expiring within window"; window from control plan
ORDER BY b.use_by ASC
LIMIT 500;
```
*Index usage:* partial `idx_batch_use_by` (only non-null `use_by` rows). The window length is a
**control-plan value**, not hard-coded (passed as `$1` + the plan's interval).

### 4.5 Temperature-breach scan
```sql
-- recent readings for a location that violate the active plan's threshold (threshold passed in)
SELECT t.id, t.location, t.temp_c, t.measured_at, t.batch_id
FROM haccp.temperature_log t
WHERE t.location = $1
  AND t.recorded_at >= $2          -- bounded by time => partition pruning on recorded_at
  AND t.temp_c > $3                -- $3 = plan max; or t.temp_c < $4 for a min
ORDER BY t.recorded_at DESC
LIMIT 200;
```
*Index usage:* `idx_templog_location_time`; the `recorded_at >= $2` bound enables **partition
pruning** so only recent partitions are touched.

### 4.6 Audit query by subject / actor / time
```sql
SELECT al.id, al.action, al.actor_id, al.actor_role, al.subject_ref,
       al.before_ref, al.after_ref, al.correlation_id, al.trace_id, al.occurred_at
FROM audit.audit_log al
WHERE al.subject_ref = $1
  AND al.occurred_at >= $2 AND al.occurred_at < $3
ORDER BY al.occurred_at DESC
LIMIT 200;
```
*Index usage:* `idx_audit_subject (subject_ref, occurred_at DESC)`; time bounds prune partitions.
Swap to `idx_audit_actor` when filtering by `actor_id`, `idx_audit_correlation` by `correlation_id`.

### 4.7 Idempotency lookup
```sql
SELECT k.state, k.request_fingerprint, k.response_status, k.response_body_ref
FROM platform.idempotency_key k
WHERE k.scope_hash = $1;     -- $1 = hash(principal, route, idempotency_key)
```
*Index usage:* PK `scope_hash`. Compare `request_fingerprint` in the app: match → replay stored
response; mismatch → `409 IDEMPOTENCY_KEY_CONFLICT` (BACKEND §7.3).

---

## 5. EXPLAIN ANALYZE checklist

Validate each critical query's plan in **staging with production-like data volume** (plans on an
empty/tiny table mislead — a seq scan can be *correct* on 50 rows). Run:
`EXPLAIN (ANALYZE, BUFFERS, VERBOSE) <query>;`

What to check, per query:

- **Index vs seq scan.** §4.1/§4.2/§4.7 must show **Index Scan / Index Only Scan**, never a
  `Seq Scan` on `batch`, `ingestion`, or `idempotency_key`. A `Seq Scan` on a large table here is a
  **red flag** (missing/unused index, or a type mismatch forcing a cast — e.g. `text` vs `uuid`).
- **Index *Only* Scan + `Heap Fetches`.** §4.1's covering index `idx_batch_lot_cover` should yield an
  **Index Only Scan** with **low `Heap Fetches`**; high heap fetches mean the visibility map is stale
  → run `VACUUM` so the IOS pays off.
- **Partial-index selection.** §4.3 (open alerts), §4.4 (expiring), §4.6 should pick the **partial**
  index (`idx_alert_open`, `idx_batch_use_by`, etc.). If the planner ignores it, the query predicate
  doesn't match the index `WHERE` clause — fix the query, not the index.
- **rows estimate vs actual.** In each node compare `rows=<est>` to `actual rows=<n>`. A large
  divergence (orders of magnitude) → stale stats: `ANALYZE` the table; consider raising
  `default_statistics_target` on skewed columns (e.g. `alert.state`, `extracted_field.confidence_band`).
- **Join strategy for the traceability join (§4.1).** For a single-lot lookup expect **Nested Loop**
  driven by `idx_batch_lot_code` then PK lookups (few rows) — good. A **Hash Join** building a hash
  over all of `ingestion`/`supplier` for a one-lot query is a **red flag** (usually a bad row estimate
  on `batch.lot_code`). For bulk/range trace queries a **Hash Join** is appropriate; judge by row
  counts, not by join type alone.
- **Sort / spill.** §4.3–§4.5 `ORDER BY`: watch for `Sort Method: external merge Disk: NNNkB`
  (spilled to disk) — a red flag. Either an index provides the order (the `... DESC` indexes do) or
  `work_mem` is too low. Prefer the index-ordered path so no sort node appears.
- **Partition pruning.** §4.5/§4.6 must show `Subplans Removed` / only the relevant partitions in the
  plan. If **all** partitions are scanned, the time predicate isn't prunable (e.g. a function wrapped
  around `recorded_at`, or no time bound) — a red flag for the append-only tables.
- **`BUFFERS`.** High `shared read` (vs `shared hit`) on a supposedly hot query → cold cache or an
  oversized scan; high `temp read/written` → a spill (see Sort).

**Capturing plans in CI/staging.** Keep a `plans/` fixture: run each critical query under
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against a seeded staging dataset in CI; assert (a) no
`Seq Scan` on the named large tables, (b) partition pruning present for the time-bounded queries,
(c) the est/actual ratio under a threshold. Enable `auto_explain` (below) in staging to catch
regressions on real traffic. Treat a plan regression like a failing test.

---

## 6. Migration strategy

**Expand-and-contract, every change reversible (up/down), zero-downtime** — consistent with
BACKEND §11.2. Tooling: **Alembic** (the backend is FastAPI/Python, ARCHITECTURE ADR-0007); each
revision has `upgrade()` and `downgrade()`.

### 6.1 The three-step pattern (representative changes)

**(a) Add a nullable column + backfill + enforce** — illustrated in
[`migrations/0001_add_batch_origin_country_expand.sql`](./migrations/0001_add_batch_origin_country_expand.sql):
1. **Expand:** `ALTER TABLE ... ADD COLUMN origin_country_iso2 text` (nullable, **no default** → a
   metadata-only change in PG 11+, no table rewrite, no long lock). Add the CHECK as `NOT VALID` so it
   binds new rows without scanning existing ones. Deploy code that **writes both** old and new shapes.
2. **Backfill:** update the new column in **batches** (`WHERE origin_country_iso2 IS NULL ... LIMIT n`
   loop) so no single long transaction locks the table; reconcile with row counts.
   `VALIDATE CONSTRAINT` afterwards (a brief `SHARE UPDATE EXCLUSIVE`, no full lock).
3. **Contract:** once all readers use the new column and metrics confirm parity, drop the old
   column/code in a **later** release.
   **Down:** drop the constraint then the column (safe in the expand phase — nothing reads it yet).

**(b) Add an index `CONCURRENTLY`** — illustrated in
[`migrations/0002_batch_use_by_index_concurrent.sql`](./migrations/0002_batch_use_by_index_concurrent.sql):
`CREATE INDEX CONCURRENTLY` builds without an `ACCESS EXCLUSIVE` lock so writes continue.
**Online-index caveat:** `CREATE INDEX CONCURRENTLY` **cannot run inside a transaction block** — in
Alembic the revision must disable the per-migration transaction (`op.get_bind()` with an AUTOCOMMIT
connection / `with op.get_context().autocommit_block():`) and run `op.execute(...)` there. A failed
concurrent build can leave an **`INVALID`** index (`pg_index.indisvalid = false`); the migration must
check and `DROP` + retry rather than assume success. **Down:** `DROP INDEX CONCURRENTLY` (also not in
a txn).

**(c) Rename a column via expand-contract (never a bare `RENAME`).** A bare `ALTER ... RENAME COLUMN`
is instant in PG but breaks any running old code that still reads the old name — not zero-downtime
across a rolling deploy. Instead: **expand** (add the new column, dual-write), **migrate** (backfill +
keep in sync), **contract** (drop the old column once no reader uses it). Each step is independently
deployable and reversible.

### 6.2 How migrations stay zero-downtime / scoped
- Additive first (new nullable columns/tables/indexes); destructive changes only after readers move.
- **Per-context schemas** keep a migration scoped to one context (no cross-schema FK to lock).
- **Append-only tables** (`raw_artifact`, `audit_log`, `temperature_log`): migrations may **add**
  nullable/defaulted columns, but the immutability contract forbids `UPDATE`/`DELETE`. A backfill on
  an immutable table is an **exception** done by the audited `labelscan_maint` role with grants
  re-tightened after — and even then the deny-mutation trigger blocks row edits, so prefer **adding a
  new append-only table** over backfilling an immutable one (BACKEND §11.2).
- New range **partitions** are created ahead of time by a scheduled maintenance job; the BEFORE-row
  immutability trigger auto-applies to them (§3.2).

---

## 7. Data retention considerations

- **HACCP/audit retention vs storage growth.** Immutable historical traceability + audit must be
  retained for the applicable compliance window. **That window is a regulatory parameter — not
  fabricated here; mark as NEEDS VERIFICATION** with the Compliance owner. Retention is implemented as
  a **policy over the partitioned append-only store**, never by mutating records: when a partition
  ages past the (verified) retention window, **detach + archive + drop the detached partition** rather
  than `DELETE` rows (which the triggers forbid and which would be slow + bloat-prone).
- **Partitioning of high-volume append-only tables.** `temperature_log`, `audit_log`, `raw_artifact`
  are `PARTITION BY RANGE` on their server timestamp (monthly buckets illustrated; tune to volume).
  Benefits: time-bounded queries **prune** to a few partitions (§5); aging out a period is a metadata
  `DETACH`/`DROP`, not a mass delete; `VACUUM`/index maintenance is per-partition.
- **Archival / cold storage.** Detached partitions can be dumped to compressed cold storage
  (object store / WORM) for the long-tail compliance window, keeping hot Postgres small. Audit
  partition **hash-chain heads** should be anchored at archival time (§3.4) so archived history stays
  verifiable.
- **Large raw images in object storage, not the DB.** Only a **content-addressed key + `checksum_sha256`
  + metadata** live in `raw_artifact`; the bytes live in the object store (ARCHITECTURE §3.1, BACKEND
  S2). *Justification:* keeps the DB and its backups small and fast, lets object storage do
  cheap/tiered/WORM retention and SSE encryption, and the checksum still ties the row to immutable
  bytes (integrity preserved without bloating Postgres).
- **PII / GDPR tension with immutability (trade-offs, no legal specifics fabricated).** Labels/photos
  may carry incidental PII (BACKEND S2). Immutable records and an erasure request pull in opposite
  directions. Options, with trade-offs:
  - **Redaction-by-reference:** the immutable row keeps only a reference; redaction replaces the
    *referenced* object-store blob, not the audit/DB row — the chain of *facts* stays intact while the
    sensitive *content* is removed.
  - **Crypto-erase:** encrypt each raw blob under a per-subject/per-object key; "erase" by destroying
    the key, rendering the blob unrecoverable while the immutable DB row (now pointing at
    irrecoverable ciphertext) is untouched.
  Both preserve append-only integrity. **Which is permissible, and the retention vs erasure balance,
  is a legal/Compliance decision — flagged NEEDS VERIFICATION, not asserted here.**

---

## 8. Performance risks

| # | Hotspot | Risk | Mitigation |
|---|---------|------|------------|
| P1 | **`audit_log` + `temperature_log` write volume** | Every business change writes an audit row; sensors can write temperature readings at high frequency → insert-heavy hot tables. | Range partitioning (inserts hit the current partition); **lean, mostly-partial indexes** (§2) to cut write amplification; consider batching sensor writes; outbox dispatch is async so audit/temp inserts aren't on a slow path. |
| P2 | **JSONB bloat** (`raw_artifact.raw_json`, `extracted_field.value`) | Large/ wide JSONB → TOAST churn, big tables, slow scans. | Keep big binaries **out** of the DB (object store); GIN on `raw_json` **only** if queried (and `jsonb_path_ops` for a smaller index); project hot scalar fields (`use_by`, `temp` bounds, `gtin`) to typed columns so queries never scan JSONB. |
| P3 | **Index write-amplification** | Each index taxes every insert on the hottest tables. | Prefer **partial** indexes (open alerts, non-null use_by, undispatched outbox, ocr_json GIN); audit the index set against actual query plans; drop unused indexes (check `pg_stat_user_indexes.idx_scan`). |
| P4 | **Traceability join at scale (§4.1)** | A bad row estimate on `lot_code` could flip a one-lot lookup into a hash join over big tables. | Covering index `idx_batch_lot_cover`; keep stats fresh (`ANALYZE`); the cross-context join is by indexed PK/uuid; CI plan assertions (§5) catch a regression. |
| P5 | **Partition pruning misses** | A query without a time bound (or wrapping the partition key in a function) scans **all** partitions. | Always bound append-only reads by the partition key (`recorded_at`/`occurred_at`); verify `Subplans Removed` in EXPLAIN (§5); avoid functions on the partition column in `WHERE`. |
| P6 | **VACUUM / autovacuum on append-only tables** | Insert-only tables don't accumulate dead tuples, but they **do** need `ANALYZE` (stats) and, pre-PG-13-vs-now, can suffer **insert-driven autovacuum** lag affecting the visibility map (→ poor Index Only Scans) and transaction-ID wraparound on huge tables. | Tune `autovacuum_vacuum_insert_scale_factor`/threshold so insert-only partitions get vacuumed for the visibility map and freezing; vacuum/freeze old partitions once before they go read-only; rely on per-partition maintenance (smaller, faster). |
| P7 | **UUIDv4 index locality** | Random `gen_random_uuid()` PKs scatter inserts across the B-tree → page splits, poor cache locality, more WAL — worst on the high-volume append-only tables. | App supplies **UUIDv7/ULID** (time-ordered) ids for `raw_artifact`, `audit_log`, `temperature_log`, `outbox` so inserts are largely append-at-the-right; column stays `uuid`. (Trade-off in §9.) |
| P8 | **Idempotency / processed_event growth** | Unbounded if never swept. | TTL sweep on `idempotency_key.expires_at` (indexed); periodically prune old `processed_event` rows past the dedup window. |

---

## 9. Trade-offs (consolidated)

Reversible choices preferred (constraint #7). Each: what it **gains** / **gives up**.

| Decision | Gains | Gives up | Reversibility |
|----------|-------|----------|---------------|
| **Typed `extracted_field` table + JSONB `value`** (vs one JSONB blob per run) | Per-field indexing on confidence/status/name; stable review-worklist queries; clean evolution as fields change | Direct SQL type-checking of the polymorphic value (delegated to the LLM gate + extraction schema); one row per field = more rows | High — value shape is JSON; can add typed projections incrementally |
| **Schema-per-context** (vs single schema) | Visible module boundaries; per-context migrations; no cross-context FK coupling; extract-to-service seam preserved | DB can't enforce cross-context referential integrity (app/events must); more schemas to manage | High — schemas are namespaces, mergeable if ever needed |
| **DB-level immutability** (grants + triggers + hash chain) vs app-level only | Enforced, provable "didn't tamper/invent"; survives app bugs | Can only supersede, never edit; backfills need an audited maint role; chaining serialises appends | Medium (intentionally hard to reverse — that's the value) |
| **Partition now** (temp/audit/raw) vs later | Pruning + cheap retention drop + per-partition maintenance from day one; avoids a painful retrofit on a huge table | A little upfront complexity (partition creation job); PK must include the partition key | High to add more; hard to *remove* once huge → bias to partition early |
| **UUIDv7/ULID** (app-supplied) vs UUIDv4 default | Index locality, fewer page splits, less WAL on hot append tables | App must mint ordered ids; very slight info leak of insert time | High — same `uuid` type; switch generators freely |
| **Covering/partial indexes** vs minimal indexing | Fast hot paths (trace lookup, open alerts, expiry scan) with low write cost | Index definitions to maintain; covering index is wider | High — drop/replace any index online (`CONCURRENTLY`) |
| **Synchronous vs deferred index builds** | Deferred (`CONCURRENTLY`) = zero-downtime, no write lock | Can't run in a txn; can leave an INVALID index; slower to build | High — drop and rebuild |
| **GTIN: CHECK shape in DB, check-digit in app** | DB rejects obviously malformed GTINs; full GS1 validity stays where it's testable (BACKEND §8.4); no fabricated validity | DB alone doesn't guarantee a valid check digit | High |

---

### Constraint coverage (quick map)
- **#1 no fabrication / unknown ⇒ null:** `ck_evidence_iff_value`, `ck_null_value_status`, JSONB
  `value` nullable. **#2 confidence per field:** `extracted_field` confidence columns (§1.3, AI-PIPELINE
  §4). **#3 raw before normalized & immutable:** `raw_artifact` append-only/partitioned + grants/trigger
  (§3). **#4 auditable + immutable:** `audit_log` append-only + hash chain + no write path (§3). **#7
  reversible:** §6, §9. **#8 correlation_id/trace_id:** present on `raw_artifact`, `ingestion`,
  `extraction_run`, `extracted_field` (via run), `temperature_log`, `alert`, `audit_log`, `outbox`.
