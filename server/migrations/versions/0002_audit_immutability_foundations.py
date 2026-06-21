"""append-only + audit foundations (immutability triggers, unbypassable audit, partitioning)

Revision ID: 0002_audit_immutability_foundations
Revises: 0001_schemas_and_roles
Create Date: 2026-06-14

PG-1 foundation, part 2/2. Installs the data-integrity bedrock BEFORE any
row-writer exists (so SLO-3 cannot be violated by code that doesn't exist yet):

  1. platform.deny_mutation()  — RAISEs on UPDATE/DELETE/TRUNCATE. Triggers fire
     for EVERY role including the table owner/superuser, so historical records
     are immutable regardless of privilege.
  2. platform.audit_on_insert() (SECURITY DEFINER) — AFTER INSERT trigger that
     writes exactly one audit.audit_log row, in the SAME transaction, reading the
     actor/action/correlation_id/trace_id from transaction-local settings. If the
     context is missing it RAISEs, aborting the insert. Audit therefore cannot be
     bypassed and cannot be forged: the app role has no direct INSERT on audit_log.
  3. The three append-only tables (audit_log, raw_artifact, temperature_log),
     RANGE-partitioned by their server timestamp, with grants that withhold
     UPDATE/DELETE from the app role (defence in depth alongside the trigger).
  4. Mutable platform working tables (idempotency_key, outbox, processed_event)
     — deliberately NOT append-only (they transition state).

Targets PostgreSQL 16: row-level triggers on a partitioned parent propagate to
all current/future partitions automatically.
"""

from __future__ import annotations

from alembic import op

revision = "0002_foundations"
down_revision = "0001_schemas_and_roles"
branch_labels = None
depends_on = None


UP = [
    # ----- 1. immutability guard -------------------------------------------------
    """
    CREATE OR REPLACE FUNCTION platform.deny_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
        RAISE EXCEPTION
            'append-only violation: % on %.% is forbidden (immutable historical record)',
            TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
            USING ERRCODE = 'restrict_violation';
    END $$;
    """,
    # ----- 2. unbypassable, same-transaction audit -------------------------------
    """
    CREATE OR REPLACE FUNCTION platform.audit_on_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = audit, pg_catalog AS $$
    DECLARE
        v_actor  text := nullif(current_setting('labelscan.actor_id',       true), '');
        v_action text := nullif(current_setting('labelscan.action',         true), '');
        v_corr   text := nullif(current_setting('labelscan.correlation_id', true), '');
        v_trace  text := nullif(current_setting('labelscan.trace_id',       true), '');
        -- The trigger fires on the physical partition; record the LOGICAL parent
        -- table so the audit log never leaks the partitioning scheme.
        v_root   oid  := COALESCE(pg_partition_root(TG_RELID), TG_RELID);
        v_schema text;
        v_table  text;
    BEGIN
        IF v_actor IS NULL OR v_action IS NULL OR v_corr IS NULL OR v_trace IS NULL THEN
            RAISE EXCEPTION
                'audit context missing: SET LOCAL labelscan.{actor_id,action,correlation_id,trace_id} is required before writing %.%',
                TG_TABLE_SCHEMA, TG_TABLE_NAME
                USING ERRCODE = 'raise_exception';
        END IF;
        SELECT n.nspname, c.relname INTO v_schema, v_table
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = v_root;
        INSERT INTO audit.audit_log
            (occurred_at, actor_id, action, subject_schema, subject_table, subject_id,
             correlation_id, trace_id)
        VALUES
            (clock_timestamp(), v_actor::uuid, v_action, v_schema, v_table,
             NEW.id, v_corr, v_trace);
        RETURN NULL;  -- AFTER trigger: return value ignored
    END $$;
    """,
    # ----- 3a. audit log (append-only, partitioned) ------------------------------
    """
    CREATE TABLE audit.audit_log (
        id              uuid        NOT NULL DEFAULT gen_random_uuid(),
        occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
        actor_id        uuid        NOT NULL,
        action          text        NOT NULL,
        subject_schema  text        NOT NULL,
        subject_table   text        NOT NULL,
        subject_id      uuid,
        correlation_id  text        NOT NULL,
        trace_id        text        NOT NULL,
        PRIMARY KEY (id, occurred_at)
    ) PARTITION BY RANGE (occurred_at);
    """,
    "CREATE TABLE audit.audit_log_2026_06 PARTITION OF audit.audit_log "
    "FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');",
    "CREATE TABLE audit.audit_log_2026_07 PARTITION OF audit.audit_log "
    "FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');",
    "CREATE TABLE audit.audit_log_default PARTITION OF audit.audit_log DEFAULT;",
    "CREATE INDEX ix_audit_log_subject ON audit.audit_log (subject_schema, subject_table, subject_id);",
    "CREATE INDEX ix_audit_log_correlation ON audit.audit_log (correlation_id);",
    # ----- 3b. raw artifact (append-only, partitioned, content-addressed) --------
    """
    CREATE TABLE ingestion.raw_artifact (
        id              uuid        NOT NULL DEFAULT gen_random_uuid(),
        occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
        ingestion_id    uuid        NOT NULL,   -- logical ref -> ingestion.ingestion (built in PG-2)
        artifact_kind   text        NOT NULL
            CONSTRAINT ck_raw_artifact_kind CHECK (artifact_kind IN ('image', 'ocr_json')),
        storage_ref     text        NOT NULL,   -- object-store key (bytes live outside the DB)
        checksum_sha256 text        NOT NULL,
        correlation_id  text        NOT NULL,
        trace_id        text        NOT NULL,
        PRIMARY KEY (id, occurred_at)
    ) PARTITION BY RANGE (occurred_at);
    """,
    "CREATE TABLE ingestion.raw_artifact_2026_06 PARTITION OF ingestion.raw_artifact "
    "FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');",
    "CREATE TABLE ingestion.raw_artifact_2026_07 PARTITION OF ingestion.raw_artifact "
    "FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');",
    "CREATE TABLE ingestion.raw_artifact_default PARTITION OF ingestion.raw_artifact DEFAULT;",
    # content-addressed: a duplicate submit never double-appends (idempotency anchor, BACKEND §7.4)
    "CREATE UNIQUE INDEX uq_raw_artifact_content "
    "ON ingestion.raw_artifact (ingestion_id, artifact_kind, checksum_sha256, occurred_at);",
    "CREATE INDEX ix_raw_artifact_ingestion ON ingestion.raw_artifact (ingestion_id);",
    # ----- 3c. temperature log (append-only, partitioned) ------------------------
    """
    CREATE TABLE haccp.temperature_log (
        id              uuid          NOT NULL DEFAULT gen_random_uuid(),
        recorded_at     timestamptz   NOT NULL DEFAULT clock_timestamp(),  -- server time (partition key)
        measured_at     timestamptz   NOT NULL,                            -- when the reading was taken
        batch_id        uuid,                                              -- logical ref -> traceability.batch
        location        text          NOT NULL,
        temp_c          numeric(5,2)  NOT NULL,
        source          text          NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sensor')),
        correlation_id  text          NOT NULL,
        trace_id        text          NOT NULL,
        PRIMARY KEY (id, recorded_at)
    ) PARTITION BY RANGE (recorded_at);
    """,
    "CREATE TABLE haccp.temperature_log_2026_06 PARTITION OF haccp.temperature_log "
    "FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');",
    "CREATE TABLE haccp.temperature_log_2026_07 PARTITION OF haccp.temperature_log "
    "FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');",
    "CREATE TABLE haccp.temperature_log_default PARTITION OF haccp.temperature_log DEFAULT;",
    "CREATE INDEX ix_temperature_log_batch ON haccp.temperature_log (batch_id);",
    # ----- 4. mutable platform working tables (NOT append-only) -------------------
    """
    CREATE TABLE platform.idempotency_key (
        scope_hash          text        PRIMARY KEY,
        request_fingerprint text        NOT NULL,
        state               text        NOT NULL CHECK (state IN ('in_progress', 'completed')),
        response_status     integer,
        response_body_ref   text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        expires_at          timestamptz NOT NULL
    );
    """,
    """
    CREATE TABLE platform.outbox (
        id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type     text        NOT NULL,
        payload        jsonb       NOT NULL,
        correlation_id text        NOT NULL,
        trace_id       text        NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        published_at   timestamptz
    );
    """,
    "CREATE INDEX ix_outbox_unpublished ON platform.outbox (created_at) WHERE published_at IS NULL;",
    """
    CREATE TABLE platform.processed_event (
        consumer     text        NOT NULL,
        event_id     uuid        NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer, event_id)
    );
    """,
    # ----- 5. triggers: immutability (all 3) + audit (the 2 business tables) ------
    "CREATE TRIGGER trg_audit_log_no_mutation BEFORE UPDATE OR DELETE ON audit.audit_log "
    "FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();",
    "CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON audit.audit_log "
    "FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();",
    "CREATE TRIGGER trg_raw_artifact_no_mutation BEFORE UPDATE OR DELETE ON ingestion.raw_artifact "
    "FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();",
    "CREATE TRIGGER trg_raw_artifact_no_truncate BEFORE TRUNCATE ON ingestion.raw_artifact "
    "FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();",
    "CREATE TRIGGER trg_temperature_log_no_mutation BEFORE UPDATE OR DELETE ON haccp.temperature_log "
    "FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();",
    "CREATE TRIGGER trg_temperature_log_no_truncate BEFORE TRUNCATE ON haccp.temperature_log "
    "FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();",
    "CREATE TRIGGER trg_raw_artifact_audit AFTER INSERT ON ingestion.raw_artifact "
    "FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();",
    "CREATE TRIGGER trg_temperature_log_audit AFTER INSERT ON haccp.temperature_log "
    "FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();",
    # ----- 6. least-privilege grants (defence in depth alongside the triggers) ----
    # append-only business tables: app may read + append, NEVER mutate.
    "GRANT SELECT, INSERT ON ingestion.raw_artifact TO labelscan_app;",
    "REVOKE UPDATE, DELETE, TRUNCATE ON ingestion.raw_artifact FROM labelscan_app, PUBLIC;",
    "GRANT SELECT, INSERT ON haccp.temperature_log TO labelscan_app;",
    "REVOKE UPDATE, DELETE, TRUNCATE ON haccp.temperature_log FROM labelscan_app, PUBLIC;",
    # audit log: app may only READ. Inserts happen solely via the SECURITY DEFINER
    # trigger, so the app can neither skip nor forge an audit entry.
    "GRANT SELECT ON audit.audit_log TO labelscan_app;",
    "REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit.audit_log FROM labelscan_app, PUBLIC;",
    # mutable working tables: state transitions are allowed.
    "GRANT SELECT, INSERT, UPDATE ON platform.idempotency_key TO labelscan_app;",
    "GRANT SELECT, INSERT, UPDATE, DELETE ON platform.outbox TO labelscan_app;",
    "GRANT SELECT, INSERT ON platform.processed_event TO labelscan_app;",
]


DOWN = [
    "DROP TABLE IF EXISTS haccp.temperature_log CASCADE;",
    "DROP TABLE IF EXISTS ingestion.raw_artifact CASCADE;",
    "DROP TABLE IF EXISTS audit.audit_log CASCADE;",
    "DROP TABLE IF EXISTS platform.processed_event CASCADE;",
    "DROP TABLE IF EXISTS platform.outbox CASCADE;",
    "DROP TABLE IF EXISTS platform.idempotency_key CASCADE;",
    "DROP FUNCTION IF EXISTS platform.audit_on_insert();",
    "DROP FUNCTION IF EXISTS platform.deny_mutation();",
]


def upgrade() -> None:
    for stmt in UP:
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
