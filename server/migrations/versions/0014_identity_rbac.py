"""identity RBAC and audited user administration

Revision ID: 0014_identity_rbac
Revises: 0013_request_idempotency
Create Date: 2026-07-26

Turns the bootstrap-only admin credential table into the account store used by
the back-office administration API:
  - three explicit roles (admin, quality_manager, operator);
  - a human display name and creator identity;
  - ``active`` as the canonical soft-disable flag;
  - database-enforced, same-transaction audit on every account INSERT/UPDATE.

Existing bootstrap accounts remain administrators, use their username as display
name, and are marked as self-created. Deletes remain unavailable to the runtime
role: account removal is a reversible deactivation.
"""

from __future__ import annotations

from alembic import op

revision = "0014_identity_rbac"
down_revision = "0013_request_idempotency"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE identity.app_user RENAME COLUMN is_active TO active;")
    op.execute(
        "ALTER TABLE identity.app_user "
        "ADD COLUMN display_name text, "
        "ADD COLUMN created_by uuid;"
    )
    op.execute(
        "UPDATE identity.app_user "
        "SET display_name = username, created_by = id;"
    )
    op.execute(
        "ALTER TABLE identity.app_user "
        "ALTER COLUMN display_name SET NOT NULL, "
        "ALTER COLUMN created_by SET NOT NULL, "
        "ADD CONSTRAINT fk_app_user_created_by "
        "FOREIGN KEY (created_by) REFERENCES identity.app_user (id);"
    )
    op.execute(
        "ALTER TABLE identity.app_user DROP CONSTRAINT ck_app_user_role;"
    )
    op.execute(
        "ALTER TABLE identity.app_user "
        "ADD CONSTRAINT ck_app_user_role "
        "CHECK (role IN ('admin', 'quality_manager', 'operator'));"
    )
    op.execute(
        "CREATE TRIGGER trg_app_user_audit "
        "AFTER INSERT OR UPDATE ON identity.app_user "
        "FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_app_user_audit ON identity.app_user;")
    # A downgrade intentionally collapses all accounts back to the only legacy role.
    op.execute("UPDATE identity.app_user SET role = 'admin';")
    op.execute(
        "ALTER TABLE identity.app_user DROP CONSTRAINT ck_app_user_role;"
    )
    op.execute(
        "ALTER TABLE identity.app_user "
        "ADD CONSTRAINT ck_app_user_role CHECK (role IN ('admin'));"
    )
    op.execute(
        "ALTER TABLE identity.app_user "
        "DROP CONSTRAINT fk_app_user_created_by, "
        "DROP COLUMN created_by, "
        "DROP COLUMN display_name;"
    )
    op.execute("ALTER TABLE identity.app_user RENAME COLUMN active TO is_active;")
