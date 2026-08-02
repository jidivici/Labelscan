"""store-scoped product catalogue

Revision ID: 0017_store_catalog
Revises: 0016_store_directory
Create Date: 2026-07-26

The store is captured when a label is submitted and copied to the immutable
traceability batch. This historical snapshot keeps catalogue ownership stable
even if the submitting user later moves to another store.
"""

from __future__ import annotations

from alembic import op

revision = "0017_store_catalog"
down_revision = "0016_store_directory"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE ingestion.ingestion "
        "ADD COLUMN store_code text, "
        "ADD CONSTRAINT ck_ingestion_store_code_not_blank "
        "CHECK (store_code IS NULL OR btrim(store_code) <> '');"
    )
    # Best-effort historical attribution: use the first audited application user
    # who wrote each ingestion. Unattributable/system-created records remain NULL.
    op.execute(
        "ALTER TABLE ingestion.ingestion DISABLE TRIGGER trg_ingestion_audit_update;"
    )
    op.execute(
        """
        UPDATE ingestion.ingestion AS i
        SET store_code = source.store_code
        FROM (
            SELECT DISTINCT ON (a.subject_id)
                a.subject_id,
                u.store_code
            FROM audit.audit_log AS a
            JOIN identity.app_user AS u ON u.id = a.actor_id
            WHERE a.subject_schema = 'ingestion'
              AND a.subject_table = 'ingestion'
              AND u.store_code IS NOT NULL
            ORDER BY a.subject_id, a.occurred_at
        ) AS source
        WHERE source.subject_id = i.id;
        """
    )
    op.execute(
        "ALTER TABLE ingestion.ingestion ENABLE TRIGGER trg_ingestion_audit_update;"
    )
    op.execute(
        "CREATE INDEX ix_ingestion_store_received "
        "ON ingestion.ingestion (store_code, server_received_at DESC);"
    )

    op.execute(
        "ALTER TABLE traceability.batch "
        "ADD COLUMN store_code text, "
        "ADD CONSTRAINT ck_batch_store_code_not_blank "
        "CHECK (store_code IS NULL OR btrim(store_code) <> '');"
    )
    # Batch is append-only at runtime. Temporarily suspend only its immutability
    # trigger for this deterministic historical backfill.
    op.execute("ALTER TABLE traceability.batch DISABLE TRIGGER trg_batch_no_mutation;")
    op.execute(
        """
        UPDATE traceability.batch AS b
        SET store_code = i.store_code
        FROM ingestion.ingestion AS i
        WHERE i.id = b.source_ingestion_id;
        """
    )
    op.execute("ALTER TABLE traceability.batch ENABLE TRIGGER trg_batch_no_mutation;")
    op.execute(
        "CREATE INDEX ix_batch_store_created "
        "ON traceability.batch (store_code, created_at DESC);"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS traceability.ix_batch_store_created;")
    op.execute(
        "ALTER TABLE traceability.batch "
        "DROP CONSTRAINT ck_batch_store_code_not_blank, "
        "DROP COLUMN store_code;"
    )
    op.execute("DROP INDEX IF EXISTS ingestion.ix_ingestion_store_received;")
    op.execute(
        "ALTER TABLE ingestion.ingestion "
        "DROP CONSTRAINT ck_ingestion_store_code_not_blank, "
        "DROP COLUMN store_code;"
    )
