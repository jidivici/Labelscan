"""Add independent, append-only hygiene declarations per portal and period."""

from alembic import op

revision = "0038_hygiene_checks"
down_revision = "0037_interim_preview_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE haccp.hygiene_check (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid NOT NULL REFERENCES identity.organization(id),
            business_portal_id uuid NOT NULL,
            FOREIGN KEY (organization_id, business_portal_id)
                REFERENCES identity.business_portal(organization_id, id),
            task_code text NOT NULL CHECK (task_code IN
                ('reception', 'temperature_am', 'temperature_pm', 'freshness',
                 'cleaning', 'tank', 'cooking', 'thermometer')),
            period_start date NOT NULL,
            performed_day date NOT NULL CHECK (performed_day >= period_start),
            outcome text NOT NULL CHECK (outcome IN ('done', 'issue', 'not_applicable')),
            notes text NOT NULL CHECK (length(btrim(notes)) BETWEEN 1 AND 4000),
            actor_id uuid NOT NULL,
            request_id uuid NOT NULL,
            recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
            source_version text NOT NULL DEFAULT 'hygiene-pms-2017-v2',
            UNIQUE (organization_id, business_portal_id, request_id)
        );
        CREATE INDEX ix_hygiene_check_period ON haccp.hygiene_check
            (organization_id, business_portal_id, task_code, period_start, recorded_at DESC);
        ALTER TABLE haccp.hygiene_check ENABLE ROW LEVEL SECURITY;
        ALTER TABLE haccp.hygiene_check FORCE ROW LEVEL SECURITY;
        CREATE POLICY hygiene_check_tenant ON haccp.hygiene_check
            USING (organization_id::text = current_setting('labelscan.organization_id', true))
            WITH CHECK (organization_id::text = current_setting('labelscan.organization_id', true));
        CREATE TRIGGER hygiene_check_no_mutation BEFORE UPDATE OR DELETE
            ON haccp.hygiene_check FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();
        CREATE TRIGGER hygiene_check_no_truncate BEFORE TRUNCATE
            ON haccp.hygiene_check FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();
        GRANT SELECT, INSERT ON haccp.hygiene_check TO labelscan_app;
    """)


def downgrade() -> None:
    op.execute("DROP TABLE haccp.hygiene_check")
