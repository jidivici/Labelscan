"""Retire the operator role and keep only admin/manager user accounts.

Revision ID: 0028_retire_operator_role
Revises: 0027_manager_portal
"""

from alembic import op


revision = "0028_retire_operator_role"
down_revision = "0027_manager_portal"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("SELECT set_config('labelscan.actor_id', '00000000-0000-0000-0000-000000000000', true)")
    op.execute("SELECT set_config('labelscan.action', 'identity.operator_role_retired', true)")
    op.execute("SELECT set_config('labelscan.correlation_id', 'migration-0028', true)")
    op.execute("SELECT set_config('labelscan.trace_id', 'migration-0028', true)")
    # Existing operators become managers. A manager has one portal, so retain the
    # deterministic first active assignment and remove only duplicate assignments
    # made possible by the old operator model.
    op.execute(
        """
        WITH ranked AS (
            SELECT assignment.organization_id, assignment.user_id,
                   assignment.portal_id,
                   row_number() OVER (
                       PARTITION BY assignment.organization_id, assignment.user_id
                       ORDER BY assignment.created_at, assignment.portal_id
                   ) AS position
            FROM identity.user_portal_assignment AS assignment
            JOIN identity.app_user AS account
              ON account.organization_id = assignment.organization_id
             AND account.id = assignment.user_id
            WHERE account.role = 'operator' AND assignment.active = true
        )
        DELETE FROM identity.user_portal_assignment AS assignment
         USING ranked
         WHERE assignment.organization_id = ranked.organization_id
           AND assignment.user_id = ranked.user_id
           AND assignment.portal_id = ranked.portal_id
           AND ranked.position > 1
        """
    )
    op.execute("UPDATE identity.app_user SET role = 'manager' WHERE role = 'operator'")
    op.execute("ALTER TABLE identity.app_user DROP CONSTRAINT ck_app_user_role")
    op.execute(
        """
        ALTER TABLE identity.app_user
        ADD CONSTRAINT ck_app_user_role
        CHECK (role IN ('super_admin', 'admin', 'manager'))
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE identity.app_user DROP CONSTRAINT ck_app_user_role")
    op.execute(
        """
        ALTER TABLE identity.app_user
        ADD CONSTRAINT ck_app_user_role
        CHECK (role IN ('super_admin', 'admin', 'manager', 'operator'))
        """
    )
