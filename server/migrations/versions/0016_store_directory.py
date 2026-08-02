"""audited store directory and user assignments

Revision ID: 0016_store_directory
Revises: 0015_remove_quality_manager_role
Create Date: 2026-07-26

Stores are part of the identity/access boundary: administrators maintain the
directory and every operator is assigned to one store code. Existing operators
are preserved under a recoverable ``NON_AFFECTE`` store.
"""

from __future__ import annotations

from alembic import op

revision = "0016_store_directory"
down_revision = "0015_remove_quality_manager_role"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE identity.store (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            code        text        NOT NULL UNIQUE,
            name        text        NOT NULL,
            active      boolean     NOT NULL DEFAULT true,
            created_by  uuid        NOT NULL REFERENCES identity.app_user (id),
            created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
            updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT ck_store_code_format CHECK (
                code = upper(btrim(code))
                AND code ~ '^[A-Z0-9][A-Z0-9._-]*$'
            ),
            CONSTRAINT ck_store_name_not_blank CHECK (btrim(name) <> '')
        );
        """
    )
    op.execute(
        """
        INSERT INTO identity.store (code, name, created_by)
        SELECT 'NON_AFFECTE', 'Non affecté', id
        FROM identity.app_user
        WHERE EXISTS (
            SELECT 1 FROM identity.app_user WHERE role = 'operator'
        )
        ORDER BY (role = 'admin') DESC, created_at
        LIMIT 1;
        """
    )
    op.execute(
        "ALTER TABLE identity.app_user ADD COLUMN store_code text;"
    )
    op.execute(
        "ALTER TABLE identity.app_user DISABLE TRIGGER trg_app_user_audit;"
    )
    op.execute(
        "UPDATE identity.app_user SET store_code = 'NON_AFFECTE' "
        "WHERE role = 'operator';"
    )
    op.execute(
        "ALTER TABLE identity.app_user ENABLE TRIGGER trg_app_user_audit;"
    )
    op.execute(
        "ALTER TABLE identity.app_user "
        "ADD CONSTRAINT fk_app_user_store_code "
        "FOREIGN KEY (store_code) REFERENCES identity.store (code), "
        "ADD CONSTRAINT ck_operator_store_required "
        "CHECK (role <> 'operator' OR store_code IS NOT NULL);"
    )
    op.execute(
        "CREATE INDEX ix_app_user_store_code "
        "ON identity.app_user (store_code);"
    )
    op.execute(
        "CREATE TRIGGER trg_store_audit "
        "AFTER INSERT OR UPDATE ON identity.store "
        "FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON identity.store TO labelscan_app;"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_store_audit ON identity.store;")
    op.execute(
        "ALTER TABLE identity.app_user "
        "DROP CONSTRAINT ck_operator_store_required, "
        "DROP CONSTRAINT fk_app_user_store_code, "
        "DROP COLUMN store_code;"
    )
    op.execute("DROP TABLE IF EXISTS identity.store;")
