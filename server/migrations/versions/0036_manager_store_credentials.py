"""Scope manager identifiers to their store.

Revision ID: 0036_manager_store_credentials
Revises: 0035_catalog_export_audit
"""

from __future__ import annotations

from alembic import op

revision = "0036_manager_store_credentials"
down_revision = "0035_catalog_export_audit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE identity.app_user
            ADD CONSTRAINT ck_manager_store_required
            CHECK (role <> 'manager' OR (store_id IS NOT NULL AND store_code IS NOT NULL))
            NOT VALID;
        ALTER TABLE identity.app_user
            VALIDATE CONSTRAINT ck_manager_store_required;

        DROP INDEX identity.uq_user_organization_username_current;

        CREATE UNIQUE INDEX uq_privileged_user_organization_username_current
            ON identity.app_user (organization_id, lower(username))
            WHERE deleted_at IS NULL AND role IN ('super_admin', 'admin');

        CREATE UNIQUE INDEX uq_manager_store_username_current
            ON identity.app_user (organization_id, store_id, lower(username))
            WHERE deleted_at IS NULL AND role = 'manager';
        """
    )


def downgrade() -> None:
    # This intentionally fails rather than discarding accounts if identifiers were
    # reused across stores after the upgrade.
    op.execute(
        """
        DROP INDEX identity.uq_manager_store_username_current;
        DROP INDEX identity.uq_privileged_user_organization_username_current;
        CREATE UNIQUE INDEX uq_user_organization_username_current
            ON identity.app_user (organization_id, username)
            WHERE deleted_at IS NULL;
        ALTER TABLE identity.app_user DROP CONSTRAINT ck_manager_store_required;
        """
    )
