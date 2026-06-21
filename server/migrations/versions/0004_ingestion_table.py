"""ingestion aggregate table (mutable, audited-on-insert) + raw_artifact FK

Revision ID: 0004_ingestion
Revises: 0003_harden_secdef
Create Date: 2026-06-14

PG-2. Adds the `ingestion.ingestion` aggregate root that the durable ingestion
write records. It is MUTABLE (status will transition in later phases) so it gets
NO deny_mutation trigger — but it IS business-critical, so every INSERT is
audited by the same unbypassable trigger.

`raw_artifact.ingestion_id` is deliberately a by-ID reference, NOT a foreign key:
`RawArtifact` is a separate aggregate from `Ingestion` (ARCHITECTURE §7.2) so its
append-only immutability stays independent of the mutable Ingestion lifecycle.
Aggregates reference each other by ID; the application writes both rows in one
transaction to keep them linked.
"""

from __future__ import annotations

from alembic import op

revision = "0004_ingestion"
down_revision = "0003_harden_secdef"
branch_labels = None
depends_on = None

# The authoritative 12-state machine (SYNTHESIS §4.3). PG-2 only ever writes 'raw_stored';
# the rest are declared so later phases need no schema change to transition.
_STATUSES = (
    "raw_stored",
    "ocr_running",
    "ocr_done",
    "ocr_failed",
    "ocr_skipped_garbage",
    "extraction_running",
    "extracted",
    "extraction_failed",
    "needs_review",
    "confirmed",
    "rejected",
    "halted_missing_context",
)


def upgrade() -> None:
    states = ", ".join(f"'{s}'" for s in _STATUSES)
    op.execute(
        f"""
        CREATE TABLE ingestion.ingestion (
            id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            status              text        NOT NULL CHECK (status IN ({states})),
            image_ref           text        NOT NULL,      -- object-store key (content-addressed)
            checksum_sha256     text        NOT NULL,
            barcode_raw         text,
            client_captured_at  timestamptz,
            server_received_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
            correlation_id      text        NOT NULL,
            trace_id            text        NOT NULL,
            created_at          timestamptz NOT NULL DEFAULT now()
        );
        """
    )
    op.execute("CREATE INDEX ix_ingestion_status ON ingestion.ingestion (status);")
    # business-critical insert -> audited by the unbypassable trigger (NOT append-only: it mutates later)
    op.execute(
        "CREATE TRIGGER trg_ingestion_audit AFTER INSERT ON ingestion.ingestion "
        "FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();"
    )
    # least privilege: app may read + insert; NO update yet (status transitions are a later phase).
    op.execute("GRANT SELECT, INSERT ON ingestion.ingestion TO labelscan_app;")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS ingestion.ingestion CASCADE;")
