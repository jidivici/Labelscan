"""Remove the obsolete account activation mechanism.

Revision ID: 0026_remove_account_activation
Revises: 0025_multi_trade
"""

from alembic import op

revision = "0026_remove_account_activation"
down_revision = "0025_multi_trade"
branch_labels = None
depends_on = None


def _ensure_tenant_policy(table: str) -> None:
    policy = table.replace(".", "_") + "_tenant_policy"
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;")
    op.execute(f"DROP POLICY IF EXISTS {policy} ON {table};")
    op.execute(
        f"""
        CREATE POLICY {policy} ON {table}
        USING (
            organization_id::text =
                current_setting('labelscan.organization_id', true)
        )
        WITH CHECK (
            organization_id::text =
                current_setting('labelscan.organization_id', true)
        );
        """
    )


def upgrade() -> None:
    op.execute(
        "DROP FUNCTION IF EXISTS "
        "identity.account_activation_organization_for_token(text);"
    )
    op.execute("DROP TABLE IF EXISTS identity.account_activation;")
    # Reconcile installations that applied an early 0025 draft: the application-
    # writable system_access flag must never bypass tenant isolation.
    for policy in (
        "identity_auth_session_refresh_lookup",
        "identity_auth_session_tenant_write",
        "identity_auth_session_tenant_update",
    ):
        op.execute(f"DROP POLICY IF EXISTS {policy} ON identity.auth_session;")
    for table in (
        "identity.app_user",
        "identity.store",
        "identity.business_portal",
        "identity.user_portal_assignment",
        "identity.auth_session",
        "ingestion.ingestion",
        "ingestion.raw_artifact",
        "traceability.batch",
        "traceability.arrival_projection",
        "haccp.alert",
    ):
        _ensure_tenant_policy(table)

    # The same early draft did not include the final catalogue search indexes.
    # IF NOT EXISTS keeps this repair harmless on already-complete databases.
    op.execute(
        """
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE INDEX IF NOT EXISTS ix_arrival_projection_fields_trgm
            ON traceability.arrival_projection
            USING gin ((fields::text) gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS ix_arrival_projection_supplier_trgm
            ON traceability.arrival_projection
            USING gin ((COALESCE(fields->>'supplier_name', '')) gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS ix_arrival_projection_lot_trgm
            ON traceability.arrival_projection
            USING gin ((COALESCE(fields->>'batch_number', '')) gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS ix_arrival_projection_org_portal_expiry
            ON traceability.arrival_projection (
                organization_id, business_portal_id, (fields->>'expiry_date'), batch_id
            );
        CREATE INDEX IF NOT EXISTS ix_arrival_projection_org_portal_product
            ON traceability.arrival_projection (
                organization_id,
                business_portal_id,
                lower(COALESCE(
                    fields->>'commercial_designation',
                    fields->>'product_name',
                    ''
                )),
                batch_id
            );
        CREATE INDEX IF NOT EXISTS ix_arrival_projection_org_portal_supplier
            ON traceability.arrival_projection (
                organization_id,
                business_portal_id,
                lower(COALESCE(fields->>'supplier_name', '')),
                batch_id
            );
        CREATE INDEX IF NOT EXISTS ix_arrival_projection_org_portal_lot
            ON traceability.arrival_projection (
                organization_id,
                business_portal_id,
                lower(COALESCE(fields->>'batch_number', '')),
                batch_id
            );
        """
    )


def downgrade() -> None:
    op.execute(
        """
        CREATE TABLE identity.account_activation (
            id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id  uuid        NOT NULL
                REFERENCES identity.organization(id),
            user_id           uuid        NOT NULL,
            token_hash        text        NOT NULL UNIQUE,
            purpose           text        NOT NULL
                CONSTRAINT ck_account_activation_purpose
                CHECK (purpose IN ('initial', 'credential_reset')),
            expires_at        timestamptz NOT NULL,
            used_at           timestamptz,
            created_by        uuid        NOT NULL,
            created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT fk_account_activation_user
                FOREIGN KEY (organization_id, user_id)
                REFERENCES identity.app_user(organization_id, id),
            CONSTRAINT fk_account_activation_creator
                FOREIGN KEY (organization_id, created_by)
                REFERENCES identity.app_user(organization_id, id),
            CONSTRAINT ck_account_activation_expiry
                CHECK (expires_at > created_at),
            CONSTRAINT ck_account_activation_used_after_creation
                CHECK (used_at IS NULL OR used_at >= created_at),
            CONSTRAINT ck_account_activation_token_hash
                CHECK (token_hash ~ '^[0-9a-f]{64}$')
        );

        CREATE INDEX ix_account_activation_org_user_expiry
            ON identity.account_activation
                (organization_id, user_id, expires_at DESC);

        GRANT SELECT, INSERT, UPDATE ON identity.account_activation TO labelscan_app;

        CREATE FUNCTION identity.account_activation_organization_for_token(
            candidate_hash text
        ) RETURNS uuid
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_catalog, identity
        SET row_security = off
        AS $$
            SELECT activation.organization_id
            FROM identity.account_activation AS activation
            WHERE activation.token_hash = candidate_hash
            LIMIT 1
        $$;

        REVOKE ALL ON FUNCTION
            identity.account_activation_organization_for_token(text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION
            identity.account_activation_organization_for_token(text) TO labelscan_app;

        ALTER TABLE identity.account_activation ENABLE ROW LEVEL SECURITY;
        CREATE POLICY identity_account_activation_tenant_policy
            ON identity.account_activation
            USING (
                organization_id = nullif(
                    current_setting('app.organization_id', true), ''
                )::uuid
            )
            WITH CHECK (
                organization_id = nullif(
                    current_setting('app.organization_id', true), ''
                )::uuid
            );
        """
    )
