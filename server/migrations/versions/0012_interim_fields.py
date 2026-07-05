"""interim_field: Tier 3 wave-2 deterministic preview fields + ocr_done transit

Revision ID: 0012_interim_fields
Revises: 0011_extraction_fields_v2
Create Date: 2026-07-02

Tier 3 (perceived-latency cascade): after the OCR completes — and BEFORE the LLM
call — the worker commits conservative regex-extracted preview fields and bumps
the ingestion status raw_stored -> ocr_done (already in the 0004 status CHECK),
so the polling client can render wave 2 seconds before the run lands.

ingestion.interim_field is a NON-AUTHORITATIVE preview store:
  - append-only + immutable (same deny_mutation triggers as extraction tables);
  - UNIQUE (ingestion_id, field_name) + the worker inserts ON CONFLICT DO NOTHING,
    so a redelivered event is idempotent (no duplicate rows, no value churn);
  - the reconciled extraction_run remains the single source of truth — nothing
    reads interim_field once a run exists (read_router only surfaces it while
    latest_fields is empty);
  - NOT audit-triggered: it is a superseded preview, not a business record (the
    ocr_done status transition on ingestion.ingestion IS audited via the existing
    trg_ingestion_audit_update).
"""

from __future__ import annotations

from alembic import op

revision = "0012_interim_fields"
down_revision = "0011_extraction_fields_v2"
branch_labels = None
depends_on = None

# Only the wave-2 extractor names (domain interim_fields.py candidates).
_FIELD_NAMES = (
    "expiry_date",
    "packaging_date",
    "storage_temperature",
    "price",
    "batch_number",
)


def upgrade() -> None:
    names = ", ".join(f"'{n}'" for n in _FIELD_NAMES)
    op.execute(
        f"""
        CREATE TABLE ingestion.interim_field (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            ingestion_id    uuid        NOT NULL REFERENCES ingestion.ingestion (id),
            field_name      text        NOT NULL CHECK (field_name IN ({names})),
            value           jsonb       NOT NULL,
            source          text        NOT NULL DEFAULT 'deterministic'
                                        CHECK (source = 'deterministic'),
            correlation_id  text        NOT NULL,
            trace_id        text        NOT NULL,
            created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT uq_interim_field_per_ingestion UNIQUE (ingestion_id, field_name)
        );
        """
    )
    op.execute(
        "CREATE INDEX ix_interim_field_ingestion ON ingestion.interim_field (ingestion_id);"
    )
    # append-only immutability (same guard as extraction_run / extracted_field)
    op.execute(
        "CREATE TRIGGER trg_interim_field_no_mutation BEFORE UPDATE OR DELETE ON ingestion.interim_field "
        "FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();"
    )
    op.execute(
        "CREATE TRIGGER trg_interim_field_no_truncate BEFORE TRUNCATE ON ingestion.interim_field "
        "FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();"
    )
    op.execute("GRANT SELECT, INSERT ON ingestion.interim_field TO labelscan_app;")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS ingestion.interim_field CASCADE;")
