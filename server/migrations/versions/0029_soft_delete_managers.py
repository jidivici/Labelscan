"""Soft-delete managers while allowing username reuse.

Revision ID: 0029_soft_delete_managers
Revises: 0028_retire_operator_role
"""

from alembic import op

revision = "0029_soft_delete_managers"
down_revision = "0028_retire_operator_role"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE identity.app_user
            ADD COLUMN deleted_at timestamptz;
        ALTER TABLE identity.app_user
            DROP CONSTRAINT uq_user_organization_username;
        CREATE UNIQUE INDEX uq_user_organization_username_current
            ON identity.app_user (organization_id, username)
            WHERE deleted_at IS NULL;
        """
    )


def downgrade() -> None:
    # A deleted username may already have been reused. Give retired credential
    # rows a deterministic internal username before restoring the old constraint.
    op.execute(
        """
        UPDATE identity.app_user
        SET username = username || '__retired__' || id::text
        WHERE deleted_at IS NOT NULL;
        DROP INDEX identity.uq_user_organization_username_current;
        ALTER TABLE identity.app_user
            ADD CONSTRAINT uq_user_organization_username
            UNIQUE (organization_id, username);
        ALTER TABLE identity.app_user DROP COLUMN deleted_at;
        """
    )
