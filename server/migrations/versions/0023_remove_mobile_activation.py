"""remove the unused mobile QR activation flow

Revision ID: 0023_remove_mobile_activation
Revises: 0022_tenant_batch_identity
Create Date: 2026-07-26
"""

from __future__ import annotations

from alembic import op

revision = "0023_remove_mobile_activation"
down_revision = "0022_tenant_batch_identity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP TABLE identity.mobile_activation;")


def downgrade() -> None:
    op.execute(
        """
        CREATE TABLE identity.mobile_activation (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid        NOT NULL REFERENCES identity.organization(id),
            token_hash      text        NOT NULL UNIQUE,
            created_by      uuid        NOT NULL REFERENCES identity.app_user(id),
            expires_at      timestamptz NOT NULL,
            used_at         timestamptz,
            created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT ck_mobile_activation_expiry CHECK (expires_at > created_at)
        );
        CREATE INDEX ix_mobile_activation_org_expiry
            ON identity.mobile_activation (organization_id, expires_at DESC);
        GRANT SELECT, INSERT, UPDATE
            ON identity.mobile_activation TO labelscan_app;
        ALTER TABLE identity.mobile_activation ENABLE ROW LEVEL SECURITY;
        CREATE POLICY identity_mobile_activation_tenant_policy
            ON identity.mobile_activation
            USING (
                current_setting('labelscan.system_access', true) = 'true'
                OR organization_id::text =
                    current_setting('labelscan.organization_id', true)
            )
            WITH CHECK (
                current_setting('labelscan.system_access', true) = 'true'
                OR organization_id::text =
                    current_setting('labelscan.organization_id', true)
            );
        CREATE TRIGGER trg_mobile_activation_audit
            AFTER INSERT OR UPDATE ON identity.mobile_activation
            FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();
        """
    )
