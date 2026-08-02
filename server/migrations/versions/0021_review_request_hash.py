"""bind atomic review idempotency keys to their request payload

Revision ID: 0021_review_request_hash
Revises: 0020_legacy_default_organization
Create Date: 2026-07-26
"""

from __future__ import annotations

from alembic import op

revision = "0021_review_request_hash"
down_revision = "0020_legacy_default_organization"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Legacy field-override rows intentionally remain NULL. Atomic review rows
    # always store a canonical SHA-256 and validate it on every replay.
    op.execute(
        "ALTER TABLE ingestion.request_idempotency "
        "ADD COLUMN request_hash text;"
    )
    op.execute(
        "ALTER TABLE ingestion.request_idempotency "
        "ADD CONSTRAINT ck_request_idempotency_hash "
        "CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE ingestion.request_idempotency "
        "DROP CONSTRAINT ck_request_idempotency_hash, "
        "DROP COLUMN request_hash;"
    )
