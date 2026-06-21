"""extraction run + extracted_field (append-only), audited status transitions, llm_output kind

Revision ID: 0005_extraction
Revises: 0004_ingestion
Create Date: 2026-06-14

PG-4. Adds the immutable extraction result tables and the machinery the
extraction consumer needs:

  - extraction_run (append-only, immutable, audited-on-insert): one row per
    extraction attempt; outcome set at insert; NEVER updated -> a re-extraction is
    a NEW row, never an overwrite. "Current" run = latest by created_at.
  - extracted_field (append-only, immutable): the per-field results. A non-null
    value MUST carry provenance + a source raw_artifact_id (no fabrication,
    enforced by CHECK). Not individually audited — the run is the audited unit.
  - audited status transitions: ingestion.ingestion gains an AFTER UPDATE audit
    trigger and the app gains UPDATE, so raw_stored -> extracted/needs_review is
    auditable (no business change escapes the audit log).
  - raw_artifact.artifact_kind grows 'llm_output' (OCR + LLM raw outputs are
    stored in the immutable raw store; their existence dedups external calls).
"""

from __future__ import annotations

from alembic import op

revision = "0005_extraction"
down_revision = "0004_ingestion"
branch_labels = None
depends_on = None

_FIELD_NAMES = (
    "product_name",
    "commercial_designation",
    "scientific_name",
    "batch_number",
    "supplier_name",
    "origin_country",
    "FAO_area",
    "production_method",
    "fishing_gear_or_farming_method",
    "expiry_date",
    "packaging_date",
    "storage_temperature",
    "allergens",
    "weight",
    "price",
)
_OUTCOMES = (
    "extraction_running",
    "extracted",
    "needs_review",
    "extraction_failed",
    "unparseable",
    "off_schema",
    "refused",
)
_VALIDATION_STATUS = (
    "present",
    "missing",
    "ambiguous",
    "normalized",
    "unnormalizable",
    "invalid",
)


def upgrade() -> None:
    # OCR + LLM raw outputs are first-class immutable raw artifacts.
    op.execute(
        "ALTER TABLE ingestion.raw_artifact DROP CONSTRAINT ck_raw_artifact_kind"
    )
    op.execute(
        "ALTER TABLE ingestion.raw_artifact ADD CONSTRAINT ck_raw_artifact_kind "
        "CHECK (artifact_kind IN ('image', 'ocr_json', 'llm_output'))"
    )

    outcomes = ", ".join(f"'{o}'" for o in _OUTCOMES)
    op.execute(
        f"""
        CREATE TABLE ingestion.extraction_run (
            id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            ingestion_id        uuid        NOT NULL,   -- by-ID ref -> ingestion.ingestion
            attempt_no          integer     NOT NULL,
            outcome             text        NOT NULL CHECK (outcome IN ({outcomes})),
            extractor_version   text        NOT NULL,
            prompt_version      text        NOT NULL,
            ocr_provider        text        NOT NULL,
            llm_model           text        NOT NULL,
            ocr_raw_ref         text,                    -- by-ID ref -> raw_artifact(ocr_json)
            rule_set_version    text        NOT NULL,
            correlation_id      text        NOT NULL,
            trace_id            text        NOT NULL,
            created_at          timestamptz NOT NULL DEFAULT clock_timestamp()
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_extraction_run_ingestion ON ingestion.extraction_run (ingestion_id, created_at DESC);"
    )

    names = ", ".join(f"'{n}'" for n in _FIELD_NAMES)
    statuses = ", ".join(f"'{s}'" for s in _VALIDATION_STATUS)
    op.execute(
        f"""
        CREATE TABLE ingestion.extracted_field (
            id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
            extraction_run_id   uuid          NOT NULL REFERENCES ingestion.extraction_run(id),  -- same aggregate
            field_name          text          NOT NULL CHECK (field_name IN ({names})),
            value               jsonb,
            evidence            jsonb,
            provenance          jsonb,        -- {{raw_artifact_id, spans:[{{page,offset_start,offset_end}}]}}
            source_raw_artifact_id uuid,      -- by-ID ref -> raw_artifact (the OCR source the value is grounded in)
            validation_status   text          NOT NULL CHECK (validation_status IN ({statuses})),
            warnings            jsonb         NOT NULL DEFAULT '[]'::jsonb,
            llm_confidence      numeric(4,3),
            ocr_confidence      numeric(4,3),
            combined_confidence numeric(4,3)  NOT NULL,
            confidence_band     text          NOT NULL CHECK (confidence_band IN ('low','medium','high')),
            source              text          NOT NULL CHECK (source IN ('llm','human')),
            created_at          timestamptz   NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT uq_field_per_run UNIQUE (extraction_run_id, field_name),
            -- evidence exists iff value exists
            CONSTRAINT ck_evidence_iff_value CHECK ((value IS NULL) = (evidence IS NULL)),
            -- NO FABRICATION: a non-null value MUST cite its source + provenance.
            CONSTRAINT ck_value_requires_provenance CHECK (
                value IS NULL OR (provenance IS NOT NULL AND source_raw_artifact_id IS NOT NULL)
            )
        );
        """
    )

    # append-only immutability on both tables
    for tbl in ("ingestion.extraction_run", "ingestion.extracted_field"):
        short = tbl.split(".")[1]
        op.execute(
            f"CREATE TRIGGER trg_{short}_no_mutation BEFORE UPDATE OR DELETE ON {tbl} "
            f"FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();"
        )
        op.execute(
            f"CREATE TRIGGER trg_{short}_no_truncate BEFORE TRUNCATE ON {tbl} "
            f"FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();"
        )
    # the RUN is the audited business unit (not each field).
    op.execute(
        "CREATE TRIGGER trg_extraction_run_audit AFTER INSERT ON ingestion.extraction_run "
        "FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();"
    )

    # audited status transitions on the mutable ingestion row (platform.audit_on_insert is the
    # generic per-row audit writer; NEW.id is present on UPDATE too).
    op.execute(
        "CREATE TRIGGER trg_ingestion_audit_update AFTER UPDATE ON ingestion.ingestion "
        "FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();"
    )

    # grants
    op.execute("GRANT UPDATE (status) ON ingestion.ingestion TO labelscan_app;")
    op.execute("GRANT SELECT, INSERT ON ingestion.extraction_run TO labelscan_app;")
    op.execute("GRANT SELECT, INSERT ON ingestion.extracted_field TO labelscan_app;")


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS trg_ingestion_audit_update ON ingestion.ingestion;"
    )
    op.execute("REVOKE UPDATE (status) ON ingestion.ingestion FROM labelscan_app;")
    op.execute("DROP TABLE IF EXISTS ingestion.extracted_field CASCADE;")
    op.execute("DROP TABLE IF EXISTS ingestion.extraction_run CASCADE;")
    op.execute(
        "ALTER TABLE ingestion.raw_artifact DROP CONSTRAINT ck_raw_artifact_kind"
    )
    op.execute(
        "ALTER TABLE ingestion.raw_artifact ADD CONSTRAINT ck_raw_artifact_kind "
        "CHECK (artifact_kind IN ('image', 'ocr_json'))"
    )
