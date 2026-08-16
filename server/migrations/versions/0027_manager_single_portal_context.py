"""Reconcile single-portal manager context for mobile and web clients.

Revision ID: 0027_manager_portal
Revises: 0026_remove_account_activation
"""

from __future__ import annotations

from alembic import op


revision = "0027_manager_portal"
down_revision = "0026_remove_account_activation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Existing managers already assigned to exactly one active portal receive the
    # same canonical store context as newly created managers.  Multi-portal legacy
    # accounts are intentionally left untouched until an administrator chooses the
    # one portal to retain in the UI.
    op.execute("SELECT set_config('labelscan.actor_id', '00000000-0000-0000-0000-000000000000', true)")
    op.execute("SELECT set_config('labelscan.action', 'identity.manager_context_reconciled', true)")
    op.execute("SELECT set_config('labelscan.correlation_id', 'migration-0027', true)")
    op.execute("SELECT set_config('labelscan.trace_id', 'migration-0027', true)")
    op.execute(
        """
        WITH single_assignment AS (
            SELECT assignment.organization_id, assignment.user_id,
                   MIN(portal.store_id::text)::uuid AS store_id,
                   MIN(store.code) AS store_code
            FROM identity.user_portal_assignment AS assignment
            JOIN identity.business_portal AS portal
              ON portal.id = assignment.portal_id
             AND portal.organization_id = assignment.organization_id
             AND portal.active = true
            JOIN identity.store AS store
              ON store.id = portal.store_id
             AND store.organization_id = portal.organization_id
             AND store.active = true
            WHERE assignment.active = true
            GROUP BY assignment.organization_id, assignment.user_id
            HAVING COUNT(*) = 1
        )
        UPDATE identity.app_user AS account
           SET store_id = scope.store_id,
               store_code = scope.store_code,
               updated_at = clock_timestamp()
          FROM single_assignment AS scope
         WHERE account.organization_id = scope.organization_id
           AND account.id = scope.user_id
           AND account.role = 'manager'
        """
    )


def downgrade() -> None:
    op.execute("SELECT set_config('labelscan.actor_id', '00000000-0000-0000-0000-000000000000', true)")
    op.execute("SELECT set_config('labelscan.action', 'identity.manager_context_reverted', true)")
    op.execute("SELECT set_config('labelscan.correlation_id', 'migration-0027', true)")
    op.execute("SELECT set_config('labelscan.trace_id', 'migration-0027', true)")
    op.execute(
        """
        UPDATE identity.app_user
           SET store_id = NULL, store_code = NULL, updated_at = clock_timestamp()
         WHERE role = 'manager'
        """
    )
