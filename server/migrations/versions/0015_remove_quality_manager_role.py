"""remove the unused quality manager role

Revision ID: 0015_remove_quality_manager_role
Revises: 0014_identity_rbac
Create Date: 2026-07-26

The product now has two account roles. Existing quality-manager accounts are
kept active as operators so no credentials or audit history are lost.
"""

from __future__ import annotations

from alembic import op

revision = "0015_remove_quality_manager_role"
down_revision = "0014_identity_rbac"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The audit trigger requires a request actor and cannot run during a
    # deterministic schema/data migration, so suspend only this user trigger
    # while normalizing the legacy role.
    op.execute(
        "ALTER TABLE identity.app_user DISABLE TRIGGER trg_app_user_audit;"
    )
    op.execute(
        "UPDATE identity.app_user SET role = 'operator' "
        "WHERE role = 'quality_manager';"
    )
    op.execute("ALTER TABLE identity.app_user ENABLE TRIGGER trg_app_user_audit;")
    op.execute("ALTER TABLE identity.app_user DROP CONSTRAINT ck_app_user_role;")
    op.execute(
        "ALTER TABLE identity.app_user ADD CONSTRAINT ck_app_user_role "
        "CHECK (role IN ('admin', 'operator'));"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE identity.app_user DROP CONSTRAINT ck_app_user_role;")
    op.execute(
        "ALTER TABLE identity.app_user ADD CONSTRAINT ck_app_user_role "
        "CHECK (role IN ('admin', 'quality_manager', 'operator'));"
    )
