"""traceability (product/supplier/batch) + HACCP (control_plan/alert)

Revision ID: 0006_traceability_haccp
Revises: 0005_extraction
Create Date: 2026-06-14

PG-5. The domain-truth layer that consumes VALIDATED extractions.

  - traceability.product / supplier / batch: append-only + audited. A batch links
    product -> supplier -> source extraction run -> source ingestion (the
    traceability chain), all by-ID across contexts. batch.status records whether
    the domain-truth checks passed ('registered') or found an inconsistency
    ('flagged') — inconsistent data is never silently accepted.
  - haccp.control_plan: append-only, versioned rules-engine configuration
    (CCP thresholds). Thresholds are DATA authored by Compliance (placeholder in
    tests) — never fabricated regulatory truth.
  - haccp.alert: mutable lifecycle (open->acknowledged->resolved), audited on
    BOTH insert and update.
  - haccp.temperature_log already exists (PG-1, append-only, audited).
"""

from __future__ import annotations

from alembic import op

revision = "0006_traceability_haccp"
down_revision = "0005_extraction"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ---- traceability: product / supplier (append-only reference data) ----
    op.execute(
        """
        CREATE TABLE traceability.product (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            common_name     text,
            scientific_name text,
            gtin            text,
            correlation_id  text        NOT NULL,
            trace_id        text        NOT NULL,
            created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT uq_product_identity UNIQUE NULLS NOT DISTINCT (common_name, scientific_name, gtin)
        );
        """
    )
    op.execute(
        """
        CREATE TABLE traceability.supplier (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            name            text        NOT NULL,
            approval_number text,
            correlation_id  text        NOT NULL,
            trace_id        text        NOT NULL,
            created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT uq_supplier_name UNIQUE (name)
        );
        """
    )
    op.execute(
        """
        CREATE TABLE traceability.batch (
            id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            lot_code               text        NOT NULL,
            gtin                   text,
            product_id             uuid        REFERENCES traceability.product(id),   -- intra-context FK
            supplier_id            uuid        REFERENCES traceability.supplier(id),  -- intra-context FK
            species_scientific     text,
            fao_area_code          text,
            production_method      text CHECK (production_method IS NULL OR production_method IN ('wild_caught','farmed')),
            use_by                 date,
            packaging_date         date,
            status                 text        NOT NULL CHECK (status IN ('registered','flagged')),
            source_ingestion_id    uuid        NOT NULL,   -- by-ID -> ingestion.ingestion
            source_extraction_run_id uuid      NOT NULL,   -- by-ID -> ingestion.extraction_run
            correlation_id         text        NOT NULL,
            trace_id               text        NOT NULL,
            created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT uq_batch_lot UNIQUE NULLS NOT DISTINCT (supplier_id, product_id, lot_code)
        );
        """
    )
    op.execute("CREATE INDEX ix_batch_lot_code ON traceability.batch (lot_code);")
    op.execute("CREATE INDEX ix_batch_supplier ON traceability.batch (supplier_id);")
    op.execute(
        "CREATE INDEX ix_batch_source_run ON traceability.batch (source_extraction_run_id);"
    )

    # ---- haccp: control_plan (append-only versioned rules) ----
    op.execute(
        """
        CREATE TABLE haccp.control_plan (
            id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            version             text        NOT NULL UNIQUE,
            max_temp_c          numeric(5,2),
            min_temp_c          numeric(5,2),
            expiry_warning_days integer,
            active              boolean     NOT NULL DEFAULT true,
            correlation_id      text        NOT NULL,
            trace_id            text        NOT NULL,
            created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_control_plan_active ON haccp.control_plan (active) WHERE active;"
    )

    # ---- haccp: alert (MUTABLE lifecycle, audited insert + update) ----
    op.execute(
        """
        CREATE TABLE haccp.alert (
            id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            batch_id            uuid,                 -- by-ID -> traceability.batch
            alert_type          text        NOT NULL CHECK (alert_type IN ('expiry','temperature','required_field','inconsistency')),
            severity            text        NOT NULL CHECK (severity IN ('low','medium','high','critical')),
            state               text        NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged','resolved')),
            control_plan_version text,
            detail              jsonb       NOT NULL DEFAULT '{}'::jsonb,
            correlation_id      text        NOT NULL,
            trace_id            text        NOT NULL,
            created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
            updated_at          timestamptz NOT NULL DEFAULT clock_timestamp()
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_alert_open ON haccp.alert (batch_id) WHERE state = 'open';"
    )

    # ---- immutability + audit triggers ----
    for tbl in ("traceability.product", "traceability.supplier", "traceability.batch"):
        short = tbl.split(".")[1]
        op.execute(
            f"CREATE TRIGGER trg_{short}_no_mutation BEFORE UPDATE OR DELETE ON {tbl} "
            f"FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();"
        )
        op.execute(
            f"CREATE TRIGGER trg_{short}_no_truncate BEFORE TRUNCATE ON {tbl} "
            f"FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();"
        )
        op.execute(
            f"CREATE TRIGGER trg_{short}_audit AFTER INSERT ON {tbl} "
            f"FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();"
        )
    # control_plan: append-only + audited
    op.execute(
        "CREATE TRIGGER trg_control_plan_no_mutation BEFORE UPDATE OR DELETE ON haccp.control_plan "
        "FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();"
    )
    op.execute(
        "CREATE TRIGGER trg_control_plan_audit AFTER INSERT ON haccp.control_plan "
        "FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();"
    )
    # alert: mutable lifecycle -> audited on insert AND update (no deny_mutation)
    op.execute(
        "CREATE TRIGGER trg_alert_audit AFTER INSERT OR UPDATE ON haccp.alert "
        "FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();"
    )

    # ---- grants (least privilege) ----
    op.execute("GRANT SELECT, INSERT ON traceability.product TO labelscan_app;")
    op.execute("GRANT SELECT, INSERT ON traceability.supplier TO labelscan_app;")
    op.execute("GRANT SELECT, INSERT ON traceability.batch TO labelscan_app;")
    op.execute("GRANT SELECT, INSERT ON haccp.control_plan TO labelscan_app;")
    op.execute("GRANT SELECT, INSERT, UPDATE ON haccp.alert TO labelscan_app;")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS haccp.alert CASCADE;")
    op.execute("DROP TABLE IF EXISTS haccp.control_plan CASCADE;")
    op.execute("DROP TABLE IF EXISTS traceability.batch CASCADE;")
    op.execute("DROP TABLE IF EXISTS traceability.supplier CASCADE;")
    op.execute("DROP TABLE IF EXISTS traceability.product CASCADE;")
