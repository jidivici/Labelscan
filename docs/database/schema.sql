-- =============================================================================
-- LabelScan — PostgreSQL schema (reference — matches migrations 0001–0009)
-- =============================================================================
-- Status:   Implemented (migrations 0001–0009 have been applied).
-- Target:   PostgreSQL 16 (uses pgcrypto's gen_random_uuid(); GENERATED columns;
--           partitioning by RANGE; partial / expression / GIN indexes).
-- Author:   Database Optimizer.
-- Scope:    LabelScan/ only.
--
-- Consistency anchors (do not contradict):
--   ARCHITECTURE.md  §2 (6 bounded contexts), §6 (events), §7 (aggregates),
--                    ADR-0003 (raw-before-normalized, immutable), ADR-0004 (append-only audit),
--                    ADR-0005 (confidence+provenance per field).
--   BACKEND-ARCHITECTURE.md §7 (idempotency, content-addressed raw store, event_id dedup),
--                    §2.3 (transactional outbox), §11 (expand-and-contract).
--   extraction.v1.schema.json (the 15 substantive label fields + per-field warnings).
--   AI-PIPELINE.md  §4 (composite confidence = recalibrated LLM ⊓ OCR floor, capped by validation).
--
-- Module boundaries are made visible at the DB level via SCHEMA-PER-CONTEXT.
-- Cross-context references are BY ID ONLY (no cross-schema FOREIGN KEYs) — see the
-- "Cross-context reference policy" note below and DATABASE.md §1/§9.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions and roles
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid(), digest()/hashing for tamper-evidence
-- NOTE: we standardise on uuid PKs. We DEFAULT them with gen_random_uuid() (UUIDv4) for
-- portability, but the application SHOULD supply UUIDv7/ULID-ordered ids for the high-volume
-- append-only tables (raw_artifact, audit_log, temperature_log) to preserve index locality.
-- See DATABASE.md §8 (UUID locality) and §9 (trade-off). Column type is `uuid` either way.

-- Roles (illustrative; created/managed by the platform, not by app code):
--   labelscan_app    -- the FastAPI runtime role: INSERT/SELECT broadly; NO UPDATE/DELETE on
--                       append-only tables (enforced by REVOKE + triggers, see §audit/immutability).
--   labelscan_maint  -- a separate, audited maintenance/backfill role used ONLY during
--                       controlled expand-and-contract migrations on immutable tables (BACKEND §11.2).
-- The GRANT/REVOKE statements live at the bottom of this file (§ Immutability enforcement).

-- ---------------------------------------------------------------------------
-- 1. Schemas — one per bounded context (ARCHITECTURE §2)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS ingestion;     -- (1) Label Ingestion & Extraction (CORE)
CREATE SCHEMA IF NOT EXISTS compliance;    -- (2) Compliance & Catalog (supporting)
CREATE SCHEMA IF NOT EXISTS traceability;  -- (3) Traceability Registry (supporting)
CREATE SCHEMA IF NOT EXISTS haccp;         -- (4) HACCP Controls & Alerting (CORE)
CREATE SCHEMA IF NOT EXISTS audit;         -- (5) Audit & History (cross-cutting, append-only)
CREATE SCHEMA IF NOT EXISTS identity;      -- (6) Identity & Access (generic)
CREATE SCHEMA IF NOT EXISTS platform;      -- cross-cutting infra: idempotency, outbox, processed-events

COMMENT ON SCHEMA ingestion    IS 'Bounded context 1: Label Ingestion & Extraction (CORE).';
COMMENT ON SCHEMA traceability IS 'Bounded context 3: Traceability Registry. References ingestion by ID only.';
COMMENT ON SCHEMA haccp        IS 'Bounded context 4: HACCP Controls & Alerting (CORE). References batches by ID only.';
COMMENT ON SCHEMA audit        IS 'Bounded context 5: append-only, immutable audit log (ADR-0004).';

-- ---------------------------------------------------------------------------
-- 2. Cross-context reference policy (ENFORCED BY CONVENTION, not FK)
-- ---------------------------------------------------------------------------
-- ARCHITECTURE §5.3: "A context never imports another context's domain. Integration is via
-- published domain events." A cross-schema FK would (a) re-introduce the compile-time coupling
-- the architecture forbids, (b) couple migration/locking across contexts, and (c) block a future
-- extract-to-service along a seam. Therefore:
--   * FOREIGN KEY constraints exist ONLY WITHIN a schema (intra-aggregate / intra-context).
--   * Cross-context links (e.g. traceability.batch.source_ingestion_id -> ingestion.ingestion.id)
--     are plain `uuid` columns, indexed, validated in the application layer / by events.
--   * Each such column is documented with a COMMENT naming the logical target.
-- This is a deliberate trade-off: we give up DB-enforced referential integrity ACROSS contexts to
-- keep module boundaries real and independently evolvable (DATABASE.md §9).

-- =============================================================================
-- CONTEXT 6 — identity (generic). Minimal: actors referenced by audit/business writes.
-- =============================================================================
CREATE TABLE identity.actor (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject       text NOT NULL,                 -- IdP `sub`
    display_name  text,
    kind          text NOT NULL DEFAULT 'human'
                  CHECK (kind IN ('human','scanner_device','service')),
    roles         text[] NOT NULL DEFAULT '{}',  -- snapshot of roles (authoritative source is the IdP)
    site_id       uuid,                           -- dormant multi-tenant hook (BACKEND S9); nullable now
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_actor_subject UNIQUE (subject)
);
COMMENT ON COLUMN identity.actor.site_id IS 'Dormant multi-site isolation hook (BACKEND S9); unused until multi-tenant.';

-- identity.app_user — credential store for JWT auth (migration 0007).
-- Mutable (passwords rotate, is_active toggles) — NO deny_mutation trigger.
-- NOT wired to audit_on_insert (security/credential table, not HACCP business record;
-- provisioning happens out-of-band via CLI with no HTTP correlation/trace context).
CREATE TABLE identity.app_user (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    username       text        NOT NULL UNIQUE,
    password_hash  text        NOT NULL,                         -- PBKDF2-HMAC-SHA256, 600k iterations
    role           text        NOT NULL DEFAULT 'admin'
                     CONSTRAINT ck_app_user_role CHECK (role IN ('admin')),
    is_active      boolean     NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
-- Grants: labelscan_app gets SELECT, INSERT, UPDATE (never DELETE — deactivate instead).

-- =============================================================================
-- CONTEXT 2 — compliance (supporting). Reference data + versioned rule set.
-- =============================================================================

-- Versioned required-field rule set. Thresholds/required-field policy are DATA, never hard-coded.
CREATE TABLE compliance.required_field_rule_set (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version       integer NOT NULL,
    is_active     boolean NOT NULL DEFAULT false,
    -- JSONB: which of the 15 fields are mandatory, per-field review-band thresholds, etc.
    -- Shape owned by the Compliance context; queryability here is secondary (read as a snapshot).
    rules         jsonb NOT NULL,
    effective_from timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_ruleset_version UNIQUE (version)
);
-- At most one active rule set at a time (partial unique index — see schema indexes).

-- Controlled vocabularies (species, FAO areas, gear types). Small reference tables.
CREATE TABLE compliance.species (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scientific_name text NOT NULL,
    common_name     text,
    CONSTRAINT uq_species_scientific UNIQUE (scientific_name)
);

CREATE TABLE compliance.fao_area (
    code  text PRIMARY KEY,            -- e.g. '27', '34' (as written on labels)
    label text NOT NULL
);

-- =============================================================================
-- CONTEXT 1 — ingestion (CORE). Raw store (append-only), ingestions, extraction runs, fields.
-- =============================================================================

-- 1a. RawArtifact (aggregate, APPEND-ONLY, ADR-0003 / ARCHITECTURE §7.2).
--     Big binary lives in object storage; here we keep a reference + checksum + raw provider JSON.
--     PARTITIONED BY RANGE(occurred_at) for time-based retention/archival (DATABASE.md §7).
CREATE TABLE ingestion.raw_artifact (
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    ingestion_id    uuid NOT NULL,                          -- logical FK -> ingestion.ingestion(id) (same context: real FK below not used because of partitioning; see note)
    artifact_kind   text NOT NULL CHECK (artifact_kind IN ('image','ocr_json')),
    -- Object-store coordinates: content-addressed key + checksum (BACKEND §7.4, S2).
    storage_key     text,                                   -- object-store key for 'image' (binary lives OUTSIDE the DB)
    checksum_sha256 bytea NOT NULL,                          -- content hash; UNIQUE per ingestion+kind => idempotent append
    content_type    text,                                    -- e.g. image/jpeg
    byte_size       bigint CHECK (byte_size IS NULL OR byte_size >= 0),
    -- Raw provider JSON for 'ocr_json' (bounding boxes + per-token confidence + geometry). Append-only.
    raw_json        jsonb,
    correlation_id  text NOT NULL,
    trace_id        text NOT NULL,
    occurred_at     timestamptz NOT NULL DEFAULT now(),      -- server-stamped (Clock); partition key
    PRIMARY KEY (id, occurred_at),                            -- partition key must be in PK
    CONSTRAINT ck_raw_image_has_key
        CHECK (artifact_kind <> 'image' OR storage_key IS NOT NULL),
    CONSTRAINT ck_raw_ocr_has_json
        CHECK (artifact_kind <> 'ocr_json' OR raw_json IS NOT NULL)
) PARTITION BY RANGE (occurred_at);
COMMENT ON TABLE  ingestion.raw_artifact IS 'APPEND-ONLY (ADR-0003). No UPDATE/DELETE (grants+trigger). Time-partitioned for retention.';
COMMENT ON COLUMN ingestion.raw_artifact.ingestion_id IS 'Logical reference to ingestion.ingestion(id) — same context; FK omitted because parent is non-partitioned and we keep raw writes decoupled/independent (ARCHITECTURE §7.2).';
COMMENT ON COLUMN ingestion.raw_artifact.checksum_sha256 IS 'Content hash; with (ingestion_id, artifact_kind) gives the content-addressed idempotency anchor (BACKEND §7.4) — a duplicate submit never double-appends.';

-- Default partition + one current monthly partition (illustrative; real partitions created by a maint job).
CREATE TABLE ingestion.raw_artifact_default PARTITION OF ingestion.raw_artifact DEFAULT;
CREATE TABLE ingestion.raw_artifact_2026_06 PARTITION OF ingestion.raw_artifact
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- 1b. Ingestion (aggregate root) — mutable lifecycle (status monotonic, enforced in app + trigger-friendly).
CREATE TABLE ingestion.ingestion (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status               text NOT NULL DEFAULT 'raw_stored'
                         CHECK (status IN (
                             'raw_stored','ocr_running','ocr_done','ocr_failed',
                             'ocr_skipped_garbage','extraction_running','extracted',
                             'extraction_failed','needs_review','confirmed','rejected',
                             'halted_missing_context')),
    barcode_raw          text,                               -- claimed by client; unvalidated until GTIN check
    client_captured_at   timestamptz,                        -- CLAIMED device time only (BACKEND S11), never authoritative
    client_meta          jsonb,
    site_id              uuid,                               -- dormant multi-tenant hook
    submitted_by         uuid,                               -- logical ref -> identity.actor(id)
    server_received_at   timestamptz NOT NULL DEFAULT now(), -- authoritative (Clock)
    confirmed_at         timestamptz,
    confirmed_by         uuid,                               -- logical ref -> identity.actor(id)
    reject_reason        text,
    correlation_id       text NOT NULL,
    trace_id             text NOT NULL,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_confirmed_requires_ts
        CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL)
);
COMMENT ON COLUMN ingestion.ingestion.client_captured_at IS 'CLAIMED device clock (AUDIT D9/R8). Never used as authoritative time; server_received_at is.';

-- 1c. ExtractionRun — each (re)extraction is a NEW run; prior runs remain queryable (ADR-0003 / immutability of confirmed history).
CREATE TABLE ingestion.extraction_run (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ingestion_id         uuid NOT NULL
                         REFERENCES ingestion.ingestion(id),         -- intra-context FK (allowed)
    raw_ocr_artifact_id  uuid,                                       -- logical ref -> raw_artifact(id) (partitioned -> no FK)
    extractor_version    text NOT NULL,                              -- e.g. 'llm-extract@2026-06-01'
    schema_version       text NOT NULL DEFAULT 'seafood-label-extraction/v1.0.0',
    rule_set_version     integer,                                    -- snapshot used (logical ref -> compliance.required_field_rule_set.version)
    outcome              text NOT NULL DEFAULT 'extraction_running'
                         CHECK (outcome IN ('extraction_running','extracted','needs_review',
                                            'extraction_failed','unparseable','off_schema','refused')),
    -- run-level (label-level) anomalies = extraction.v1 top-level `raw_warnings` array.
    raw_warnings         jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- raw LLM output ref for calibration/debug (never trusted as fields until the gate validates).
    raw_output_ref       text,
    mean_token_confidence numeric(4,3) CHECK (mean_token_confidence IS NULL OR (mean_token_confidence BETWEEN 0 AND 1)),
    is_superseded        boolean NOT NULL DEFAULT false,             -- newer run exists; old run never edited, only flagged
    correlation_id       text NOT NULL,
    trace_id             text NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE ingestion.extraction_run IS 'Corrections create a NEW run, never overwrite (ADR-0003). Old runs flagged is_superseded, never deleted.';

-- 1d. ExtractedField — the per-field provenance row.
--     DECISION: a TYPED extracted_field table (one row per field per run), with the normalized,
--     polymorphic value kept in a JSONB column. Rationale (DATABASE.md §9):
--       * The 15 field VALUE shapes are heterogeneous (string, {raw,iso}, {kind,celsius_min,...},
--         arrays) — a single typed SQL column per field would be 15 sparse columns or a wide table.
--       * Confidence/evidence/validation_status/warnings are UNIFORM across all fields → they get
--         real typed columns here (queryable, indexable: "all low-confidence required fields").
--       * The polymorphic normalized value lives in JSONB `value` (flexible), while the few
--         cross-field query needs (use_by date, storage temp bounds, GTIN) are surfaced as
--         GENERATED/derived columns on the batch (traceability) where HACCP actually queries them.
--     Trade-off named: typed rows give clean indexing on confidence/status/field_name and a stable
--     schema as fields evolve; we accept a JSON `value` (less directly type-checked in SQL) for the
--     heterogeneous payloads. Alternative (one JSONB blob per run) loses per-field indexing.
CREATE TABLE ingestion.extracted_field (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    extraction_run_id    uuid NOT NULL
                         REFERENCES ingestion.extraction_run(id) ON DELETE CASCADE,  -- intra-context
    field_name           text NOT NULL
                          CHECK (field_name IN (
                              'product_name','commercial_designation','scientific_name',
                              'batch_number','supplier_name','origin_country','FAO_area',
                              'production_method','fishing_gear_or_farming_method','expiry_date',
                              'packaging_date','storage_temperature','allergens','weight','price',
                              'gtin')),
    -- Normalized polymorphic value (extraction.v1 per-type shapes). NULL value => 'missing'/'ambiguous'.
    value                jsonb,
    -- Provenance/quality — UNIFORM, typed, indexable:
    evidence             jsonb,                                       -- verbatim substrings from raw OCR; NULL iff value NULL
    validation_status    text NOT NULL
                         CHECK (validation_status IN ('present','missing','ambiguous',
                                                      'normalized','unnormalizable','invalid')),
    warnings             jsonb NOT NULL DEFAULT '[]'::jsonb,          -- per-field warnings (extraction.v1)
    -- Composite confidence (AI-PIPELINE §4): keep the COMPONENT signals + the combined score + band,
    -- so "how confident, and why" is answerable. Numeric for arithmetic/threshold queries.
    llm_confidence       numeric(4,3) CHECK (llm_confidence IS NULL OR (llm_confidence BETWEEN 0 AND 1)),
    ocr_confidence       numeric(4,3) CHECK (ocr_confidence IS NULL OR (ocr_confidence BETWEEN 0 AND 1)),
    combined_confidence  numeric(4,3) NOT NULL CHECK (combined_confidence BETWEEN 0 AND 1),
    confidence_band      text NOT NULL CHECK (confidence_band IN ('low','medium','high')),
    -- Provenance of the value itself (ADR-0005): 'llm', 'gs1' (barcode-exact, confidence 1.0),
    -- or 'human' (override). Original retained as a separate row.
    source               text NOT NULL DEFAULT 'llm' CHECK (source IN ('llm','human','gs1')),
    source_ref           text,                                        -- raw OCR token-span ref
    superseded_by_field_id uuid REFERENCES ingestion.extracted_field(id),  -- human override chain (original retained)
    created_at           timestamptz NOT NULL DEFAULT now(),
    -- No-fabrication invariant (ADR-0005, BACKEND §8.2.2): evidence present IFF value present;
    -- a non-null value MUST carry confidence band/source_ref.
    CONSTRAINT ck_evidence_iff_value
        CHECK ((value IS NULL AND evidence IS NULL) OR (value IS NOT NULL AND evidence IS NOT NULL)),
    CONSTRAINT ck_null_value_status
        CHECK (value IS NOT NULL OR validation_status IN ('missing','ambiguous'))
);
COMMENT ON TABLE ingestion.extracted_field IS 'One row per (run, field). value is polymorphic JSONB; confidence/evidence/status are typed+indexable (DATABASE.md §9). Human overrides add a NEW row, original retained (ADR-0005).';

-- =============================================================================
-- CONTEXT 3 — traceability (supporting). Suppliers, products, batches/lots.
-- =============================================================================
CREATE TABLE traceability.supplier (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL,
    approval_number text,                                   -- CE/health mark; shape-validated in app
    site_id         uuid,                                    -- dormant multi-tenant hook
    is_active       boolean NOT NULL DEFAULT true,           -- soft-deactivate only (referenced by immutable batches)
    version         integer NOT NULL DEFAULT 1,              -- optimistic concurrency (If-Match ETag, BACKEND §4.5)
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE traceability.product (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gtin        text,                                        -- nullable; validated GS1 check-digit when present
    name        text NOT NULL,
    species_id  uuid,                                        -- logical ref -> compliance.species(id)
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- GTIN length/numeric shape sanity (full check-digit validated in app, BACKEND §8.4):
    CONSTRAINT ck_gtin_shape
        CHECK (gtin IS NULL OR gtin ~ '^[0-9]{8}$|^[0-9]{12,14}$'),
    CONSTRAINT uq_product_gtin UNIQUE (gtin)                 -- partial-unique on non-null handled via index below if desired
);

CREATE TABLE traceability.batch (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lot_code             text NOT NULL,
    gtin                 text,                               -- denormalized for fast trace lookup; GS1-validated in app
    product_id           uuid REFERENCES traceability.product(id),     -- intra-context FK
    supplier_id          uuid REFERENCES traceability.supplier(id),    -- intra-context FK; NULL => unknown_supplier
    species_scientific   text,                               -- denormalized snapshot at confirm time
    fao_area_code        text,
    production_method    text CHECK (production_method IS NULL OR production_method IN ('wild_caught','farmed')),
    -- use_by surfaced as a typed column (HACCP queries it heavily) — sourced from confirmed extracted_field.
    use_by               date,
    packaging_date       date,
    source_ingestion_id  uuid NOT NULL,                      -- logical ref -> ingestion.ingestion(id) (provenance)
    site_id              uuid,                                -- dormant multi-tenant hook
    created_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_batch_gtin_shape
        CHECK (gtin IS NULL OR gtin ~ '^[0-9]{8}$|^[0-9]{12,14}$'),
    -- lot_code unique per supplier+product (ARCHITECTURE §7.3).
    -- PG 15+ NULLS NOT DISTINCT so an unknown_supplier (NULL) + same lot still collides as expected.
    CONSTRAINT uq_batch_lot UNIQUE NULLS NOT DISTINCT (supplier_id, product_id, lot_code)
);
COMMENT ON COLUMN traceability.batch.use_by IS 'Typed projection of the confirmed expiry_date extracted_field; HACCP expiry scans index this.';
COMMENT ON COLUMN traceability.batch.source_ingestion_id IS 'Logical ref to ingestion.ingestion(id) — cross-context, no FK (ARCHITECTURE §5.3).';

-- =============================================================================
-- CONTEXT 4 — haccp (CORE). Control plans, temperature logs (append-only), alerts.
-- =============================================================================

-- Versioned, immutable-once-active control plan (ARCHITECTURE §7.5).
CREATE TABLE haccp.control_plan (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    version       integer NOT NULL,
    is_active     boolean NOT NULL DEFAULT false,
    -- thresholds (temperature ranges, expiry windows) as data; immutable once active.
    thresholds    jsonb NOT NULL,
    effective_from timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_control_plan_version UNIQUE (version)
);

-- TemperatureLog — APPEND-ONLY stream of facts (ARCHITECTURE §7 note). Time-partitioned (high volume).
CREATE TABLE haccp.temperature_log (
    id            uuid NOT NULL DEFAULT gen_random_uuid(),
    location      text NOT NULL,
    temp_c        numeric(5,2) NOT NULL CHECK (temp_c BETWEEN -80 AND 60),   -- physical sanity bound
    measured_at   timestamptz NOT NULL,                      -- when the reading was taken (may be client/sensor)
    recorded_at   timestamptz NOT NULL DEFAULT now(),        -- server-stamped append time; partition key
    batch_id      uuid,                                       -- logical ref -> traceability.batch(id) (cross-context)
    source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','sensor')),
    site_id       uuid,
    correlation_id text NOT NULL,
    trace_id      text NOT NULL,
    PRIMARY KEY (id, recorded_at)                             -- partition key in PK
) PARTITION BY RANGE (recorded_at);
COMMENT ON TABLE haccp.temperature_log IS 'APPEND-ONLY readings (no UPDATE/DELETE). Time-partitioned by recorded_at for retention/pruning.';

CREATE TABLE haccp.temperature_log_default PARTITION OF haccp.temperature_log DEFAULT;
CREATE TABLE haccp.temperature_log_2026_06 PARTITION OF haccp.temperature_log
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Alert (aggregate root, ARCHITECTURE §7.6). Lifecycle monotonic open->acknowledged->resolved.
CREATE TABLE haccp.alert (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_type           text NOT NULL CHECK (alert_type IN ('expiry','temperature','required_field')),
    severity             text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
    state                text NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged','resolved')),
    batch_id             uuid,                                -- logical ref -> traceability.batch(id)
    location             text,
    control_plan_version integer NOT NULL,                    -- which plan version triggered it (explainability)
    detail               jsonb,                               -- e.g. {temp_c, threshold} or {use_by, window}
    site_id              uuid,
    raised_at            timestamptz NOT NULL DEFAULT now(),
    acknowledged_at      timestamptz,
    acknowledged_by      uuid,                                -- logical ref -> identity.actor(id)
    resolved_at          timestamptz,
    resolved_by          uuid,
    resolution_note      text,
    correlation_id       text NOT NULL,
    trace_id             text NOT NULL,
    CONSTRAINT ck_ack_ts  CHECK (state <> 'acknowledged' OR acknowledged_at IS NOT NULL),
    CONSTRAINT ck_resolved_ts CHECK (state <> 'resolved' OR resolved_at IS NOT NULL)
);

-- =============================================================================
-- CONTEXT 5 — audit (append-only, immutable, ADR-0004). Time-partitioned + hash-chained.
-- =============================================================================
CREATE TABLE audit.audit_log (
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    action          text NOT NULL,                            -- e.g. 'ExtractionConfirmed' (stable codes)
    actor_id        uuid,                                     -- logical ref -> identity.actor(id)
    actor_role      text,
    subject_ref     text NOT NULL,                            -- e.g. 'ingestion:ing_01J...' (URN-ish, cross-context safe)
    before_ref      text,                                     -- ref to immutable snapshot (NOT a live row)
    after_ref       text,
    correlation_id  text NOT NULL,
    trace_id        text NOT NULL,
    site_id         uuid,
    occurred_at     timestamptz NOT NULL DEFAULT now(),       -- server Clock; partition key
    -- Tamper-evidence (optional, ADR-0004 / BACKEND S8): hash chain over (prev_hash || row payload).
    prev_hash       bytea,
    entry_hash      bytea NOT NULL,
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
COMMENT ON TABLE audit.audit_log IS 'APPEND-ONLY, immutable (ADR-0004). No write API; written only via AuditLogPort. Optional hash chain (prev_hash/entry_hash) for tamper-evidence.';

CREATE TABLE audit.audit_log_default PARTITION OF audit.audit_log DEFAULT;
CREATE TABLE audit.audit_log_2026_06 PARTITION OF audit.audit_log
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- =============================================================================
-- CONTEXT platform — idempotency keys, processed-event dedup, transactional outbox.
-- =============================================================================

-- Idempotency-Key store (BACKEND §7.2). Scope = (principal, route, key).
CREATE TABLE platform.idempotency_key (
    scope_hash          bytea PRIMARY KEY,                    -- hash of (principal, route, idempotency_key)
    request_fingerprint bytea NOT NULL,                       -- hash of normalized request (incl. image checksum)
    state               text NOT NULL DEFAULT 'in_progress'
                        CHECK (state IN ('in_progress','completed','failed')),
    response_status     integer,
    response_body_ref   text,                                 -- ref to stored response (replay verbatim)
    principal           text NOT NULL,
    route               text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL                  -- TTL ~24h; swept
);
COMMENT ON TABLE platform.idempotency_key IS 'Replay store (BACKEND §7.3). Same key+fingerprint => replay stored response; same key+different fingerprint => 409 conflict.';

-- Processed-event dedup for at-least-once delivery (BACKEND §7.4). One row per (consumer, event_id).
CREATE TABLE platform.processed_event (
    consumer      text NOT NULL,
    event_id      uuid NOT NULL,
    processed_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);
COMMENT ON TABLE platform.processed_event IS 'event_id dedup for at-least-once bus; re-delivery of a seen (consumer,event_id) is a no-op.';

-- Transactional outbox (BACKEND §2.3): event written in the SAME tx as the aggregate change.
-- DLQ + backoff columns added by migration 0009.
CREATE TABLE platform.outbox (
    event_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      text NOT NULL,                            -- e.g. 'ingestion.raw_stored'
    aggregate_ref   text NOT NULL,
    payload         jsonb NOT NULL,                           -- includes envelope: correlation_id, trace_id, actor, schema_version
    correlation_id  text NOT NULL,
    trace_id        text NOT NULL,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    dispatched_at   timestamptz,                              -- NULL => undispatched (the work queue)
    attempts        integer NOT NULL DEFAULT 0,               -- retry counter (migration 0009)
    next_retry_at   timestamptz,                              -- not-before time for next claim (backoff)
    last_error      text,                                     -- last traceback for ops triage
    status          text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','published','dead_letter'))  -- lifecycle (migration 0009)
);
COMMENT ON TABLE platform.outbox IS 'Transactional outbox with DLQ + exponential backoff (migration 0009). Failed events retry with equal-jitter backoff; exhausted -> dead_letter (alertable, replayable).';

-- =============================================================================
-- INDEX STRATEGY (DATABASE.md §2). Every FK indexed; lookup/partial/GIN/composite as needed.
-- =============================================================================

-- compliance
CREATE UNIQUE INDEX uq_ruleset_one_active ON compliance.required_field_rule_set (is_active)
    WHERE is_active;                                          -- at most one active rule set

-- ingestion.raw_artifact (partitioned -> indexes are local per partition automatically)
-- Content-addressed idempotent append anchor + FK-ish lookup.
-- PG-16 RULE: a UNIQUE index on a partitioned table MUST include ALL partition-key columns,
-- so occurred_at is part of the key. Consequence: uniqueness is global across partitions only for
-- the same occurred_at bucket; a true cross-time duplicate is additionally prevented at the app
-- layer (BACKEND §7.4) — and a duplicate submit happens within seconds (same partition), so the
-- DB-level guarantee covers the real idempotency case. (See DATABASE.md §3.3.)
CREATE UNIQUE INDEX uq_raw_artifact_content
    ON ingestion.raw_artifact (ingestion_id, artifact_kind, checksum_sha256, occurred_at);
CREATE INDEX idx_raw_artifact_ingestion
    ON ingestion.raw_artifact (ingestion_id);                 -- supports the logical FK / lookups
CREATE INDEX idx_raw_artifact_correlation
    ON ingestion.raw_artifact (correlation_id);
-- GIN only if raw OCR JSON is queried by content (otherwise skip — write amplification):
CREATE INDEX idx_raw_artifact_json_gin
    ON ingestion.raw_artifact USING gin (raw_json jsonb_path_ops)
    WHERE artifact_kind = 'ocr_json';

-- ingestion.ingestion
CREATE INDEX idx_ingestion_status_received
    ON ingestion.ingestion (status, server_received_at DESC); -- status board / worklists
CREATE INDEX idx_ingestion_barcode
    ON ingestion.ingestion (barcode_raw) WHERE barcode_raw IS NOT NULL;
CREATE INDEX idx_ingestion_submitted_by
    ON ingestion.ingestion (submitted_by);
-- partial index: "needs review" worklist (hot, small subset)
CREATE INDEX idx_ingestion_needs_review
    ON ingestion.ingestion (server_received_at DESC)
    WHERE status = 'needs_review';

-- ingestion.extraction_run
CREATE INDEX idx_extraction_run_ingestion
    ON ingestion.extraction_run (ingestion_id, created_at DESC);  -- FK + "latest run"
-- partial: the current (non-superseded) run per ingestion — the common read
CREATE INDEX idx_extraction_run_current
    ON ingestion.extraction_run (ingestion_id)
    WHERE NOT is_superseded;

-- ingestion.extracted_field
CREATE INDEX idx_extracted_field_run
    ON ingestion.extracted_field (extraction_run_id);            -- FK
-- composite for "show me the run's fields by name":
CREATE INDEX idx_extracted_field_run_name
    ON ingestion.extracted_field (extraction_run_id, field_name);
-- partial: low-confidence fields needing review (small hot subset)
CREATE INDEX idx_extracted_field_low_conf
    ON ingestion.extracted_field (extraction_run_id, field_name)
    WHERE confidence_band = 'low' OR validation_status IN ('ambiguous','invalid','missing');
CREATE INDEX idx_extracted_field_override_chain
    ON ingestion.extracted_field (superseded_by_field_id)
    WHERE superseded_by_field_id IS NOT NULL;

-- traceability.supplier
CREATE INDEX idx_supplier_name ON traceability.supplier (name);
CREATE INDEX idx_supplier_active ON traceability.supplier (id) WHERE is_active;

-- traceability.product
-- (uq_product_gtin already indexes gtin; partial-unique alternative if multiple NULLs desired:)
-- CREATE UNIQUE INDEX uq_product_gtin_nn ON traceability.product (gtin) WHERE gtin IS NOT NULL;
CREATE INDEX idx_product_species ON traceability.product (species_id);

-- traceability.batch — THE traceability lookup hot path
CREATE INDEX idx_batch_lot_code ON traceability.batch (lot_code);             -- by-lot lookup
CREATE INDEX idx_batch_gtin ON traceability.batch (gtin) WHERE gtin IS NOT NULL;
CREATE INDEX idx_batch_supplier ON traceability.batch (supplier_id);          -- FK
CREATE INDEX idx_batch_product ON traceability.batch (product_id);            -- FK
CREATE INDEX idx_batch_source_ingestion ON traceability.batch (source_ingestion_id); -- logical FK / provenance join
-- partial: expiring soon (non-null use_by) — HACCP expiry-window scan
CREATE INDEX idx_batch_use_by ON traceability.batch (use_by)
    WHERE use_by IS NOT NULL;
-- covering index for by-lot trace (index-only-ish for the common projection):
CREATE INDEX idx_batch_lot_cover ON traceability.batch (lot_code)
    INCLUDE (gtin, supplier_id, product_id, use_by, source_ingestion_id);

-- haccp.control_plan
CREATE UNIQUE INDEX uq_control_plan_one_active ON haccp.control_plan (is_active) WHERE is_active;

-- haccp.temperature_log (partitioned)
CREATE INDEX idx_templog_location_time ON haccp.temperature_log (location, recorded_at DESC);
CREATE INDEX idx_templog_batch ON haccp.temperature_log (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_templog_measured ON haccp.temperature_log (measured_at DESC);

-- haccp.alert
CREATE INDEX idx_alert_batch ON haccp.alert (batch_id) WHERE batch_id IS NOT NULL;  -- logical FK
CREATE INDEX idx_alert_type_state ON haccp.alert (alert_type, state, raised_at DESC);
-- partial: OPEN alerts (the hot operational worklist)
CREATE INDEX idx_alert_open ON haccp.alert (severity, raised_at DESC) WHERE state = 'open';
CREATE INDEX idx_alert_open_by_location ON haccp.alert (location, raised_at DESC)
    WHERE state = 'open' AND location IS NOT NULL;

-- audit.audit_log (partitioned)
CREATE INDEX idx_audit_subject ON audit.audit_log (subject_ref, occurred_at DESC);
CREATE INDEX idx_audit_actor ON audit.audit_log (actor_id, occurred_at DESC);
CREATE INDEX idx_audit_action ON audit.audit_log (action, occurred_at DESC);
CREATE INDEX idx_audit_correlation ON audit.audit_log (correlation_id);

-- platform
CREATE INDEX idx_idempotency_expires ON platform.idempotency_key (expires_at);   -- TTL sweep
-- Outbox indexes (migration 0009 replaced ix_outbox_unpublished with claimable + dead_letter):
CREATE INDEX ix_outbox_claimable ON platform.outbox (created_at)
    WHERE dispatched_at IS NULL AND status <> 'dead_letter';           -- worker claim (hot)
CREATE INDEX ix_outbox_dead_letter ON platform.outbox (created_at)
    WHERE status = 'dead_letter';                                      -- ops triage / requeue

-- =============================================================================
-- IMMUTABILITY ENFORCEMENT (DATABASE.md §3, ADR-0003/0004, BACKEND S8)
-- =============================================================================
-- Two layers: (1) REVOKE UPDATE/DELETE from the app role; (2) a defensive trigger that RAISEs
-- on UPDATE/DELETE (catches any path, incl. a mis-granted role). Belt and braces.

CREATE OR REPLACE FUNCTION platform.deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'append-only table %.% forbids % (ADR-0003/0004)',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- raw_artifact: attach to each partition (triggers don't cascade to partitions automatically for ROW;
-- attach to the partitioned parent for statement-level safety, plus per-partition for row-level).
CREATE TRIGGER trg_raw_artifact_no_update
    BEFORE UPDATE OR DELETE ON ingestion.raw_artifact
    FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();

CREATE TRIGGER trg_audit_no_update
    BEFORE UPDATE OR DELETE ON audit.audit_log
    FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();

CREATE TRIGGER trg_templog_no_update
    BEFORE UPDATE OR DELETE ON haccp.temperature_log
    FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();
-- NOTE (PG-16): a BEFORE ROW trigger on a partitioned table IS propagated to all partitions
-- (including future ones), so these three statements cover all current and future partitions.

-- Grant model (illustrative; run by a superuser/owner during provisioning, NOT by app code):
--   REVOKE UPDATE, DELETE, TRUNCATE ON ingestion.raw_artifact      FROM labelscan_app;
--   REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_log             FROM labelscan_app;
--   REVOKE UPDATE, DELETE, TRUNCATE ON haccp.temperature_log       FROM labelscan_app;
--   GRANT  INSERT, SELECT ON ingestion.raw_artifact, audit.audit_log, haccp.temperature_log TO labelscan_app;
-- The maintenance role (labelscan_maint) may be granted temporary ALTER for additive expand-and-contract
-- migrations only, then re-tightened (BACKEND §11.2). The trigger still blocks UPDATE/DELETE even for it.

-- =============================================================================
-- End of schema.sql
-- =============================================================================
