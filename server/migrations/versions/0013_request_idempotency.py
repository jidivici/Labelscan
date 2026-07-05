"""request_idempotency: server-side Idempotency-Key dedup for review writes (P3)

Revision ID: 0013_request_idempotency
Revises: 0012_interim_fields
Create Date: 2026-07-03

The mobile outbox retries review writes (field overrides, confirms) with a STABLE
Idempotency-Key generated once at enqueue. The override repository already dedups
by VALUE (same human value on the latest run → replayed); this table adds the
KEY-scoped guard the value check cannot give: a reviewer flip A→B→A retried out of
order must replay the recorded outcome of THAT request, never append a third run.

One row per (endpoint, actor, key), pointing at the run the original request
produced. Append-only + immutable (same deny_mutation guard as the extraction
tables); written in the SAME transaction as the run it records, so a crash never
leaves a key without its result (or vice versa). Confirms are state-idempotent by
nature and do not use this table.
"""

from __future__ import annotations

from alembic import op

revision = "0013_request_idempotency"
down_revision = "0012_interim_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE ingestion.request_idempotency (
            endpoint         text        NOT NULL CHECK (endpoint IN ('override_field')),
            actor_id         uuid        NOT NULL,
            idempotency_key  text        NOT NULL,
            ingestion_id     uuid        NOT NULL REFERENCES ingestion.ingestion (id),
            run_id           uuid        NOT NULL REFERENCES ingestion.extraction_run (id),
            field_name       text        NOT NULL,
            created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
            PRIMARY KEY (endpoint, actor_id, idempotency_key)
        );
        """
    )
    op.execute(
        "CREATE TRIGGER trg_request_idempotency_no_mutation BEFORE UPDATE OR DELETE "
        "ON ingestion.request_idempotency "
        "FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();"
    )
    op.execute(
        "CREATE TRIGGER trg_request_idempotency_no_truncate BEFORE TRUNCATE "
        "ON ingestion.request_idempotency "
        "FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();"
    )
    op.execute(
        "GRANT SELECT, INSERT ON ingestion.request_idempotency TO labelscan_app;"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS ingestion.request_idempotency CASCADE;")
