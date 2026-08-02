"""scope the visible batch business key to one organization

Revision ID: 0022_tenant_batch_identity
Revises: 0021_review_request_hash
Create Date: 2026-07-26
"""

from __future__ import annotations

from alembic import op

revision = "0022_tenant_batch_identity"
down_revision = "0021_review_request_hash"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE traceability.batch DROP CONSTRAINT uq_batch_lot, "
        "ADD CONSTRAINT uq_batch_lot "
        "UNIQUE NULLS NOT DISTINCT "
        "(organization_id, supplier_id, product_id, lot_code);"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE traceability.batch DROP CONSTRAINT uq_batch_lot, "
        "ADD CONSTRAINT uq_batch_lot "
        "UNIQUE NULLS NOT DISTINCT (supplier_id, product_id, lot_code);"
    )
