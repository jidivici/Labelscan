"""Add a tenant-scoped, append-only catalogue export audit.

Revision ID: 0035_catalog_export_audit
Revises: 0034_sanitized_image_artifact

The runtime role cannot insert into either audit table directly.  A narrow
SECURITY DEFINER function reads transaction-local tenant/audit settings and is
owned by the existing least-privilege ``labelscan_auditor`` role.
"""

from __future__ import annotations

from alembic import op

revision = "0035_catalog_export_audit"
down_revision = "0034_sanitized_image_artifact"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE audit.catalog_export_log (
            id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
            occurred_at timestamptz DEFAULT clock_timestamp() NOT NULL,
            organization_id uuid NOT NULL,
            actor_id uuid NOT NULL,
            export_format text NOT NULL,
            row_count integer NOT NULL,
            filter_sha256 text NOT NULL,
            correlation_id text NOT NULL,
            trace_id text NOT NULL,
            CONSTRAINT ck_catalog_export_format
                CHECK (export_format IN ('json', 'csv')),
            CONSTRAINT ck_catalog_export_row_count
                CHECK (row_count BETWEEN 0 AND 10000),
            CONSTRAINT ck_catalog_export_filter_sha256
                CHECK (filter_sha256 ~ '^[0-9a-f]{64}$'),
            CONSTRAINT ck_catalog_export_context_bounds
                CHECK (length(correlation_id) BETWEEN 1 AND 200
                       AND length(trace_id) BETWEEN 1 AND 200)
        );

        ALTER TABLE audit.catalog_export_log ENABLE ROW LEVEL SECURITY;
        ALTER TABLE audit.catalog_export_log FORCE ROW LEVEL SECURITY;

        CREATE POLICY catalog_export_log_tenant_policy
            ON audit.catalog_export_log
            USING (
                organization_id::text =
                current_setting('labelscan.organization_id', true)
            )
            WITH CHECK (
                organization_id::text =
                current_setting('labelscan.organization_id', true)
            );

        CREATE TRIGGER trg_catalog_export_log_no_mutation
            BEFORE UPDATE OR DELETE ON audit.catalog_export_log
            FOR EACH ROW EXECUTE FUNCTION platform.deny_mutation();
        CREATE TRIGGER trg_catalog_export_log_no_truncate
            BEFORE TRUNCATE ON audit.catalog_export_log
            FOR EACH STATEMENT EXECUTE FUNCTION platform.deny_mutation();

        REVOKE ALL ON TABLE audit.catalog_export_log
            FROM PUBLIC, labelscan_app, labelscan_auditor;
        GRANT SELECT ON TABLE audit.catalog_export_log TO labelscan_app;
        GRANT INSERT ON TABLE audit.catalog_export_log TO labelscan_auditor;

        CREATE FUNCTION platform.record_catalog_export(
            requested_format text,
            requested_row_count integer,
            requested_filter_sha256 text
        ) RETURNS void
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path TO ''
        AS $$
        DECLARE
            tenant_setting text := nullif(
                current_setting('labelscan.organization_id', true), ''
            );
            actor_setting text := nullif(
                current_setting('labelscan.actor_id', true), ''
            );
            correlation_setting text := nullif(
                current_setting('labelscan.correlation_id', true), ''
            );
            trace_setting text := nullif(
                current_setting('labelscan.trace_id', true), ''
            );
            audit_tenant_id uuid;
            audit_actor_id uuid;
        BEGIN
            IF tenant_setting IS NULL OR actor_setting IS NULL
               OR correlation_setting IS NULL OR trace_setting IS NULL THEN
                RAISE EXCEPTION
                    'catalog export audit context is incomplete'
                    USING ERRCODE = 'raise_exception';
            END IF;
            BEGIN
                audit_tenant_id := tenant_setting::uuid;
                audit_actor_id := actor_setting::uuid;
            EXCEPTION WHEN others THEN
                RAISE EXCEPTION
                    'catalog export audit context contains an invalid uuid'
                    USING ERRCODE = 'raise_exception';
            END;
            IF requested_format NOT IN ('json', 'csv')
               OR requested_row_count NOT BETWEEN 0 AND 10000
               OR requested_filter_sha256 !~ '^[0-9a-f]{64}$'
               OR length(correlation_setting) NOT BETWEEN 1 AND 200
               OR length(trace_setting) NOT BETWEEN 1 AND 200 THEN
                RAISE EXCEPTION
                    'catalog export audit values are invalid'
                    USING ERRCODE = 'raise_exception';
            END IF;

            INSERT INTO audit.catalog_export_log (
                organization_id,
                actor_id,
                export_format,
                row_count,
                filter_sha256,
                correlation_id,
                trace_id
            ) VALUES (
                audit_tenant_id,
                audit_actor_id,
                requested_format,
                requested_row_count,
                requested_filter_sha256,
                correlation_setting,
                trace_setting
            );
            RETURN;
        END;
        $$;

        REVOKE ALL ON FUNCTION platform.record_catalog_export(text, integer, text)
            FROM PUBLIC;
        ALTER FUNCTION platform.record_catalog_export(text, integer, text)
            OWNER TO labelscan_auditor;
        GRANT EXECUTE ON FUNCTION
            platform.record_catalog_export(text, integer, text)
            TO labelscan_app;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP FUNCTION IF EXISTS
            platform.record_catalog_export(text, integer, text);
        DROP TABLE IF EXISTS audit.catalog_export_log;
        """
    )
