"""temporary default-organization compatibility for additive rollout

Revision ID: 0020_legacy_default_organization
Revises: 0019_mobile_activation_audit
Create Date: 2026-07-26

Old writers remain accepted during the staged deployment, but their rows are
always assigned to the LabelScan default organization by the database itself.
"""

from __future__ import annotations

from alembic import op

revision = "0020_legacy_default_organization"
down_revision = "0019_mobile_activation_audit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION platform.default_organization_id()
        RETURNS uuid
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_catalog, identity
        AS $$
          SELECT id FROM identity.organization WHERE slug = 'labelscan'
        $$;
        REVOKE ALL ON FUNCTION platform.default_organization_id() FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION platform.default_organization_id() TO labelscan_app;

        ALTER TABLE identity.store
            ALTER COLUMN organization_id
                SET DEFAULT platform.default_organization_id(),
            ALTER COLUMN organization_code SET DEFAULT 'labelscan';
        ALTER TABLE identity.app_user
            ALTER COLUMN organization_id
                SET DEFAULT platform.default_organization_id(),
            ALTER COLUMN organization_code SET DEFAULT 'labelscan';
        ALTER TABLE ingestion.ingestion
            ALTER COLUMN organization_id
                SET DEFAULT platform.default_organization_id();
        ALTER TABLE ingestion.raw_artifact
            ALTER COLUMN organization_id
                SET DEFAULT platform.default_organization_id();
        ALTER TABLE traceability.batch
            ALTER COLUMN organization_id
                SET DEFAULT platform.default_organization_id();
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE traceability.batch ALTER COLUMN organization_id DROP DEFAULT;
        ALTER TABLE ingestion.raw_artifact ALTER COLUMN organization_id DROP DEFAULT;
        ALTER TABLE ingestion.ingestion ALTER COLUMN organization_id DROP DEFAULT;
        ALTER TABLE identity.app_user
            ALTER COLUMN organization_code DROP DEFAULT,
            ALTER COLUMN organization_id DROP DEFAULT;
        ALTER TABLE identity.store
            ALTER COLUMN organization_code DROP DEFAULT,
            ALTER COLUMN organization_id DROP DEFAULT;
        DROP FUNCTION platform.default_organization_id();
        """
    )
