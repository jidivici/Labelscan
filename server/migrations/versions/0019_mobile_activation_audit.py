"""audit one-time mobile activation lifecycle

Revision ID: 0019_mobile_activation_audit
Revises: 0018_enterprise_tenancy
Create Date: 2026-07-26
"""

from __future__ import annotations

from alembic import op

revision = "0019_mobile_activation_audit"
down_revision = "0018_enterprise_tenancy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TRIGGER trg_mobile_activation_audit
        AFTER INSERT OR UPDATE ON identity.mobile_activation
        FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS trg_mobile_activation_audit "
        "ON identity.mobile_activation;"
    )
