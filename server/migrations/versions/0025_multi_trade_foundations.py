"""multi-trade portal, ownership snapshots, and tenant-scoped HACCP alerts

Revision ID: 0025_multi_trade
Revises: 0024_auth_sessions
Create Date: 2026-08-04

This is the expand/backfill/constraint foundation for the three business
portals.  Existing stores receive all three portals, while historical business
rows are attributed to ``poissonnerie`` whenever their store is known.  Rows
whose store could not be recovered deliberately keep a NULL portal id, but
still retain the legacy trade snapshot.

The new composite foreign keys are intentionally redundant with globally
unique UUID primary keys: they make an organization mismatch impossible at the
database boundary instead of relying on application-side authorization.
"""

from __future__ import annotations

from alembic import op

revision = "0025_multi_trade"
down_revision = "0024_auth_sessions"
branch_labels = None
depends_on = None


# Exact 0024 allow-list from migration 0011. Legacy-only names remain valid
# because extracted_field is append-only and old runs must stay restorable.
_LEGACY_EXTRACTED_FIELD_NAMES = (
    "product_name",
    "commercial_designation",
    "scientific_name",
    "batch_number",
    "supplier_name",
    "origin_country",
    "FAO_area",
    "production_method",
    "fishing_gear_or_farming_method",
    "expiry_date",
    "packaging_date",
    "storage_temperature",
    "allergens",
    "weight",
    "price",
    "gtin",
    "producer_name",
    "reseller_brand",
    "health_mark",
)

# animal_category and cutting_country are retained because they are already in
# the version-1 boucherie profile deployed with this migration. The other names
# are the complete specific-field union for the three supported trades.
_MULTI_TRADE_ADDED_FIELD_NAMES = (
    "animal_species",
    "animal_category",
    "cut_name",
    "birth_country",
    "rearing_country",
    "slaughter_country",
    "cutting_country",
    "slaughterhouse_approval",
    "cutting_plant_approval",
    "product_family",
    "manufacturer_name",
    "preparation_date",
    "conditioning_type",
    "storage_mode",
    "use_instructions",
    "reheating_instructions",
    "ingredients",
    "additives",
)
_MULTI_TRADE_EXTRACTED_FIELD_NAMES = (
    _LEGACY_EXTRACTED_FIELD_NAMES + _MULTI_TRADE_ADDED_FIELD_NAMES
)


def _set_extracted_field_names(names: tuple[str, ...]) -> None:
    joined = ", ".join(f"'{name}'" for name in names)
    op.execute(
        "ALTER TABLE ingestion.extracted_field "
        "DROP CONSTRAINT extracted_field_field_name_check;"
    )
    op.execute(
        "ALTER TABLE ingestion.extracted_field "
        "ADD CONSTRAINT extracted_field_field_name_check "
        f"CHECK (field_name IN ({joined}));"
    )


def _tenant_policy(table: str) -> None:
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


def _legacy_tenant_policy(table: str) -> None:
    """Restore the pre-0025 policy when downgrading to the 0024 contract."""
    policy = table.replace(".", "_") + "_tenant_policy"
    op.execute(f"DROP POLICY IF EXISTS {policy} ON {table};")
    op.execute(
        f"""
        CREATE POLICY {policy} ON {table}
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
        """
    )


def upgrade() -> None:
    # ------------------------------------------------------------------ expand
    _set_extracted_field_names(_MULTI_TRADE_EXTRACTED_FIELD_NAMES)
    op.execute(
        """
        CREATE TABLE identity.profession (
            code        text        PRIMARY KEY,
            name        text        NOT NULL,
            active      boolean     NOT NULL DEFAULT true,
            created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT ck_profession_code CHECK (
                code IN ('poissonnerie', 'boucherie', 'charcuterie_traiteur')
            ),
            CONSTRAINT ck_profession_name_not_blank CHECK (btrim(name) <> '')
        );

        INSERT INTO identity.profession (code, name)
        VALUES
            ('poissonnerie', 'Poissonnerie'),
            ('boucherie', 'Boucherie'),
            ('charcuterie_traiteur', 'Charcuterie–Traiteur');

        -- Required by all organization-qualified references to app_user.
        ALTER TABLE identity.app_user
            ADD CONSTRAINT uq_app_user_organization_id
            UNIQUE (organization_id, id);

        CREATE TABLE identity.business_portal (
            id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id  uuid        NOT NULL
                REFERENCES identity.organization(id),
            store_id         uuid        NOT NULL,
            profession_code  text        NOT NULL
                REFERENCES identity.profession(code),
            name             text        NOT NULL,
            active           boolean     NOT NULL DEFAULT true,
            created_by       uuid        NOT NULL,
            created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
            updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT uq_business_portal_store_profession
                UNIQUE (organization_id, store_id, profession_code),
            CONSTRAINT uq_business_portal_organization_id
                UNIQUE (organization_id, id),
            CONSTRAINT uq_business_portal_org_store_id
                UNIQUE (organization_id, store_id, id),
            CONSTRAINT fk_business_portal_organization_store
                FOREIGN KEY (organization_id, store_id)
                REFERENCES identity.store(organization_id, id),
            CONSTRAINT fk_business_portal_organization_creator
                FOREIGN KEY (organization_id, created_by)
                REFERENCES identity.app_user(organization_id, id),
            CONSTRAINT ck_business_portal_name_not_blank
                CHECK (btrim(name) <> '')
        );

        CREATE TABLE identity.user_portal_assignment (
            id               uuid        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
            organization_id  uuid        NOT NULL
                REFERENCES identity.organization(id),
            user_id           uuid        NOT NULL,
            portal_id         uuid        NOT NULL,
            created_by        uuid        NOT NULL,
            active            boolean     NOT NULL DEFAULT true,
            created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
            updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
            PRIMARY KEY (user_id, portal_id),
            CONSTRAINT fk_user_portal_assignment_user
                FOREIGN KEY (organization_id, user_id)
                REFERENCES identity.app_user(organization_id, id),
            CONSTRAINT fk_user_portal_assignment_portal
                FOREIGN KEY (organization_id, portal_id)
                REFERENCES identity.business_portal(organization_id, id),
            CONSTRAINT fk_user_portal_assignment_creator
                FOREIGN KEY (organization_id, created_by)
                REFERENCES identity.app_user(organization_id, id)
        );

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

        CREATE INDEX ix_business_portal_org_active
            ON identity.business_portal (organization_id, active, store_id);
        CREATE INDEX ix_user_portal_assignment_org_portal
            ON identity.user_portal_assignment (organization_id, portal_id, user_id);
        CREATE INDEX ix_user_portal_assignment_org_user
            ON identity.user_portal_assignment (organization_id, user_id);
        CREATE INDEX ix_account_activation_org_user_expiry
            ON identity.account_activation
                (organization_id, user_id, expires_at DESC);

        ALTER TABLE ingestion.ingestion
            ADD COLUMN business_portal_id uuid,
            ADD COLUMN trade_code_snapshot text NOT NULL DEFAULT 'poissonnerie',
            ADD COLUMN trade_profile_version text NOT NULL DEFAULT '1',
            ADD COLUMN captured_by_user_id uuid;

        ALTER TABLE traceability.batch
            ADD COLUMN business_portal_id uuid,
            ADD COLUMN trade_code_snapshot text NOT NULL DEFAULT 'poissonnerie',
            ADD COLUMN trade_profile_version text NOT NULL DEFAULT '1',
            ADD COLUMN captured_by_user_id uuid;

        ALTER TABLE traceability.arrival_projection
            ADD COLUMN business_portal_id uuid,
            ADD COLUMN trade_code_snapshot text NOT NULL DEFAULT 'poissonnerie',
            ADD COLUMN trade_profile_version text NOT NULL DEFAULT '1',
            ADD COLUMN captured_by_user_id uuid;

        ALTER TABLE haccp.alert
            ADD COLUMN organization_id uuid
                DEFAULT platform.default_organization_id(),
            ADD COLUMN store_id uuid,
            ADD COLUMN business_portal_id uuid;

        ALTER TABLE identity.auth_session ADD COLUMN client_type text;
        """
    )

    # --------------------------------------------------------------- backfill
    # Every existing store receives exactly one portal for each supported trade.
    op.execute(
        """
        INSERT INTO identity.business_portal (
            organization_id, store_id, profession_code, name, created_by
        )
        SELECT
            store.organization_id,
            store.id,
            profession.code,
            profession.name,
            store.created_by
        FROM identity.store AS store
        CROSS JOIN identity.profession AS profession
        ON CONFLICT (organization_id, store_id, profession_code) DO NOTHING;

        -- Existing sessions predate the surface discriminator.  Treating them
        -- as browser sessions avoids silently granting mobile provenance.
        UPDATE identity.auth_session SET client_type = 'browser';
        """
    )

    # Updating audited/immutable historical roots is a migration-only operation.
    op.execute(
        "ALTER TABLE ingestion.ingestion DISABLE TRIGGER trg_ingestion_audit_update;"
    )
    op.execute(
        """
        UPDATE ingestion.ingestion AS ingestion
        SET business_portal_id = portal.id
        FROM identity.business_portal AS portal
        WHERE portal.organization_id = ingestion.organization_id
          AND portal.store_id = ingestion.store_id
          AND portal.profession_code = 'poissonnerie'
          AND ingestion.store_id IS NOT NULL;

        UPDATE ingestion.ingestion AS ingestion
        SET captured_by_user_id = source.actor_id
        FROM (
            SELECT DISTINCT ON (audit.subject_id)
                audit.subject_id,
                audit.actor_id,
                app_user.organization_id
            FROM audit.audit_log AS audit
            JOIN identity.app_user AS app_user ON app_user.id = audit.actor_id
            WHERE audit.subject_schema = 'ingestion'
              AND audit.subject_table = 'ingestion'
            ORDER BY audit.subject_id, audit.occurred_at
        ) AS source
        WHERE source.subject_id = ingestion.id
          AND source.organization_id = ingestion.organization_id;
        """
    )
    op.execute(
        "ALTER TABLE ingestion.ingestion ENABLE TRIGGER trg_ingestion_audit_update;"
    )

    op.execute("ALTER TABLE traceability.batch DISABLE TRIGGER trg_batch_no_mutation;")
    op.execute(
        """
        UPDATE traceability.batch AS batch
        SET business_portal_id = ingestion.business_portal_id,
            trade_code_snapshot = ingestion.trade_code_snapshot,
            trade_profile_version = ingestion.trade_profile_version,
            captured_by_user_id = ingestion.captured_by_user_id
        FROM ingestion.ingestion AS ingestion
        WHERE ingestion.id = batch.source_ingestion_id
          AND ingestion.organization_id = batch.organization_id;
        """
    )
    op.execute("ALTER TABLE traceability.batch ENABLE TRIGGER trg_batch_no_mutation;")

    op.execute(
        """
        UPDATE traceability.arrival_projection AS projection
        SET business_portal_id = batch.business_portal_id,
            trade_code_snapshot = batch.trade_code_snapshot,
            trade_profile_version = batch.trade_profile_version,
            captured_by_user_id = batch.captured_by_user_id
        FROM traceability.batch AS batch
        WHERE batch.id = projection.batch_id
          AND batch.organization_id = projection.organization_id;
        """
    )

    op.execute("ALTER TABLE haccp.alert DISABLE TRIGGER trg_alert_audit;")
    op.execute(
        """
        UPDATE haccp.alert AS alert
        SET organization_id = batch.organization_id,
            store_id = batch.store_id,
            business_portal_id = batch.business_portal_id
        FROM traceability.batch AS batch
        WHERE batch.id = alert.batch_id;

        UPDATE haccp.alert
        SET organization_id = platform.default_organization_id()
        WHERE organization_id IS NULL;
        """
    )
    op.execute("ALTER TABLE haccp.alert ENABLE TRIGGER trg_alert_audit;")

    # Existing operators are assigned only to their store's seafood portal.
    op.execute(
        """
        INSERT INTO identity.user_portal_assignment (
            organization_id, user_id, portal_id, created_by
        )
        SELECT
            app_user.organization_id,
            app_user.id,
            portal.id,
            portal.created_by
        FROM identity.app_user AS app_user
        JOIN identity.business_portal AS portal
          ON portal.organization_id = app_user.organization_id
         AND portal.store_id = app_user.store_id
         AND portal.profession_code = 'poissonnerie'
        WHERE app_user.role = 'operator'
          AND app_user.store_id IS NOT NULL
        ON CONFLICT (user_id, portal_id) DO NOTHING;
        """
    )

    # Runtime assignment changes are soft state transitions and must share the
    # same unbypassable, same-transaction audit floor as account administration.
    # Install the trigger only after the deterministic legacy backfill above.
    op.execute(
        """
        CREATE TRIGGER trg_user_portal_assignment_audit
        AFTER INSERT OR UPDATE ON identity.user_portal_assignment
        FOR EACH ROW EXECUTE FUNCTION platform.audit_on_insert();
        """
    )

    # ----------------------------------------------------------- constraints
    op.execute(
        """
        ALTER TABLE identity.app_user DROP CONSTRAINT ck_app_user_role;
        ALTER TABLE identity.app_user
            ADD CONSTRAINT ck_app_user_role
            CHECK (role IN ('super_admin', 'admin', 'manager', 'operator'));

        ALTER TABLE identity.auth_session
            ALTER COLUMN client_type SET DEFAULT 'browser',
            ALTER COLUMN client_type SET NOT NULL,
            ADD CONSTRAINT ck_auth_session_client_type
                CHECK (client_type IN ('browser', 'mobile'));

        ALTER TABLE ingestion.ingestion
            ADD CONSTRAINT fk_ingestion_business_portal
                FOREIGN KEY (organization_id, store_id, business_portal_id)
                REFERENCES identity.business_portal(organization_id, store_id, id),
            ADD CONSTRAINT fk_ingestion_trade_snapshot
                FOREIGN KEY (trade_code_snapshot)
                REFERENCES identity.profession(code),
            ADD CONSTRAINT fk_ingestion_captured_by
                FOREIGN KEY (organization_id, captured_by_user_id)
                REFERENCES identity.app_user(organization_id, id),
            ADD CONSTRAINT ck_ingestion_trade_profile_version
                CHECK (btrim(trade_profile_version) <> ''),
            ADD CONSTRAINT ck_ingestion_store_portal_consistency
                CHECK (store_id IS NULL OR business_portal_id IS NOT NULL);

        ALTER TABLE traceability.batch DROP CONSTRAINT uq_batch_lot;
        ALTER TABLE traceability.batch
            ADD CONSTRAINT uq_batch_lot UNIQUE NULLS NOT DISTINCT
                (organization_id, business_portal_id, supplier_id, product_id, lot_code),
            ADD CONSTRAINT fk_batch_business_portal
                FOREIGN KEY (organization_id, store_id, business_portal_id)
                REFERENCES identity.business_portal(organization_id, store_id, id),
            ADD CONSTRAINT fk_batch_trade_snapshot
                FOREIGN KEY (trade_code_snapshot)
                REFERENCES identity.profession(code),
            ADD CONSTRAINT fk_batch_captured_by
                FOREIGN KEY (organization_id, captured_by_user_id)
                REFERENCES identity.app_user(organization_id, id),
            ADD CONSTRAINT ck_batch_trade_profile_version
                CHECK (btrim(trade_profile_version) <> ''),
            ADD CONSTRAINT ck_batch_store_portal_consistency
                CHECK (store_id IS NULL OR business_portal_id IS NOT NULL);

        ALTER TABLE traceability.arrival_projection
            ADD CONSTRAINT fk_arrival_projection_business_portal
                FOREIGN KEY (organization_id, store_id, business_portal_id)
                REFERENCES identity.business_portal(organization_id, store_id, id),
            ADD CONSTRAINT fk_arrival_projection_trade_snapshot
                FOREIGN KEY (trade_code_snapshot)
                REFERENCES identity.profession(code),
            ADD CONSTRAINT fk_arrival_projection_captured_by
                FOREIGN KEY (organization_id, captured_by_user_id)
                REFERENCES identity.app_user(organization_id, id),
            ADD CONSTRAINT ck_arrival_projection_trade_profile_version
                CHECK (btrim(trade_profile_version) <> ''),
            ADD CONSTRAINT ck_arrival_projection_store_portal_consistency
                CHECK (store_id IS NULL OR business_portal_id IS NOT NULL);

        ALTER TABLE haccp.alert
            ALTER COLUMN organization_id SET NOT NULL,
            ADD CONSTRAINT fk_alert_organization
                FOREIGN KEY (organization_id)
                REFERENCES identity.organization(id),
            ADD CONSTRAINT fk_alert_organization_store
                FOREIGN KEY (organization_id, store_id)
                REFERENCES identity.store(organization_id, id),
            ADD CONSTRAINT fk_alert_business_portal
                FOREIGN KEY (organization_id, store_id, business_portal_id)
                REFERENCES identity.business_portal(organization_id, store_id, id),
            ADD CONSTRAINT ck_alert_store_portal_consistency
                CHECK (store_id IS NULL OR business_portal_id IS NOT NULL);

        CREATE INDEX ix_ingestion_org_portal_received
            ON ingestion.ingestion
                (organization_id, business_portal_id, server_received_at DESC);
        CREATE INDEX ix_ingestion_org_captured_received
            ON ingestion.ingestion
                (organization_id, captured_by_user_id, server_received_at DESC);
        CREATE INDEX ix_batch_org_portal_created
            ON traceability.batch
                (organization_id, business_portal_id, created_at DESC);
        CREATE INDEX ix_arrival_projection_org_portal_recorded
            ON traceability.arrival_projection
                (organization_id, business_portal_id, recorded_at DESC);
        CREATE INDEX ix_alert_org_portal_state_created
            ON haccp.alert
                (organization_id, business_portal_id, state, created_at DESC);
        """
    )

    # Catalogue filters are server-side and frequently target values stored in
    # the JSONB projection. Trigram prefilters keep substring search bounded,
    # while expression indexes cover the user-selectable sort columns.
    op.execute(
        """
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE INDEX ix_arrival_projection_fields_trgm
            ON traceability.arrival_projection
            USING gin ((fields::text) gin_trgm_ops);
        CREATE INDEX ix_arrival_projection_supplier_trgm
            ON traceability.arrival_projection
            USING gin ((COALESCE(
                fields->>'reseller_brand',
                fields->>'producer_name',
                fields->>'supplier_name',
                ''
            )) gin_trgm_ops);
        CREATE INDEX ix_arrival_projection_lot_trgm
            ON traceability.arrival_projection
            USING gin ((COALESCE(fields->>'batch_number', '')) gin_trgm_ops);
        CREATE INDEX ix_arrival_projection_org_portal_expiry
            ON traceability.arrival_projection (
                organization_id,
                business_portal_id,
                (fields->>'expiry_date'),
                batch_id
            );
        CREATE INDEX ix_arrival_projection_org_portal_product
            ON traceability.arrival_projection (
                organization_id,
                business_portal_id,
                (COALESCE(
                    fields->>'commercial_designation',
                    fields->>'product_name',
                    ''
                )),
                batch_id
            );
        CREATE INDEX ix_arrival_projection_org_portal_supplier
            ON traceability.arrival_projection (
                organization_id,
                business_portal_id,
                (COALESCE(
                    fields->>'reseller_brand',
                    fields->>'producer_name',
                    fields->>'supplier_name',
                    ''
                )),
                batch_id
            );
        CREATE INDEX ix_arrival_projection_org_portal_lot
            ON traceability.arrival_projection (
                organization_id,
                business_portal_id,
                (fields->>'batch_number'),
                batch_id
            );
        """
    )

    # ----------------------------------------------------------- RLS / grants
    op.execute("GRANT SELECT ON identity.profession TO labelscan_app;")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON identity.business_portal TO labelscan_app;"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON identity.user_portal_assignment "
        "TO labelscan_app;"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON identity.account_activation TO labelscan_app;"
    )

    # Global, immutable-at-runtime reference data: all tenants may read it, but
    # labelscan_app receives no mutation privilege.
    op.execute("ALTER TABLE identity.profession ENABLE ROW LEVEL SECURITY;")
    op.execute(
        "CREATE POLICY identity_profession_reference_read "
        "ON identity.profession FOR SELECT USING (true);"
    )
    # No application-controlled GUC may disable RLS. The old
    # ``labelscan.system_access`` escape hatch was writable by labelscan_app and
    # therefore was not an authorization boundary. Recreate every tenant policy
    # introduced in 0018, plus the new portal policies, as tenant-only rules.
    for table in (
        "identity.app_user",
        "identity.store",
        "identity.business_portal",
        "identity.user_portal_assignment",
        "ingestion.ingestion",
        "ingestion.raw_artifact",
        "traceability.batch",
        "traceability.arrival_projection",
    ):
        _tenant_policy(table)

    # Token hashes must never become cross-tenant readable just so the API can
    # discover which tenant owns an opaque credential. These SECURITY DEFINER
    # helpers disclose only the organization UUID; callers then set the tenant
    # context and perform the real, RLS-protected, locking query.
    op.execute(
        """
        CREATE FUNCTION identity.auth_session_organization_for_token(
            candidate_hash text
        ) RETURNS uuid
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_catalog, identity
        SET row_security = off
        AS $$
            SELECT session.organization_id
            FROM identity.auth_session AS session
            WHERE session.refresh_token_hash = candidate_hash
            LIMIT 1
        $$;

        CREATE FUNCTION identity.auth_session_organization_for_family(
            candidate_family uuid,
            candidate_user uuid
        ) RETURNS uuid
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_catalog, identity
        SET row_security = off
        AS $$
            SELECT session.organization_id
            FROM identity.auth_session AS session
            WHERE session.family_id = candidate_family
              AND session.user_id = candidate_user
            LIMIT 1
        $$;

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
            identity.auth_session_organization_for_token(text) FROM PUBLIC;
        REVOKE ALL ON FUNCTION
            identity.auth_session_organization_for_family(uuid, uuid) FROM PUBLIC;
        REVOKE ALL ON FUNCTION
            identity.account_activation_organization_for_token(text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION
            identity.auth_session_organization_for_token(text) TO labelscan_app;
        GRANT EXECUTE ON FUNCTION
            identity.auth_session_organization_for_family(uuid, uuid) TO labelscan_app;
        GRANT EXECUTE ON FUNCTION
            identity.account_activation_organization_for_token(text) TO labelscan_app;
        """
    )

    op.execute(
        "DROP POLICY IF EXISTS identity_auth_session_refresh_lookup "
        "ON identity.auth_session;"
    )
    op.execute(
        "DROP POLICY IF EXISTS identity_auth_session_tenant_write "
        "ON identity.auth_session;"
    )
    op.execute(
        "DROP POLICY IF EXISTS identity_auth_session_tenant_update "
        "ON identity.auth_session;"
    )
    _tenant_policy("identity.auth_session")

    op.execute("ALTER TABLE identity.account_activation ENABLE ROW LEVEL SECURITY;")
    _tenant_policy("identity.account_activation")
    _tenant_policy("haccp.alert")


def downgrade() -> None:
    # Never silently collapse privileged accounts into a different role.  An
    # operator must explicitly remediate them before downgrading the schema.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM identity.app_user
                WHERE role IN ('super_admin', 'manager')
            ) THEN
                RAISE EXCEPTION
                    'cannot safely downgrade 0025 while super_admin or manager accounts exist';
            END IF;
        END $$;
        """
    )
    new_names = ", ".join(f"'{name}'" for name in _MULTI_TRADE_ADDED_FIELD_NAMES)
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM ingestion.extracted_field
                WHERE field_name IN ({new_names})
            ) THEN
                RAISE EXCEPTION
                    'cannot safely downgrade 0025 while multi-trade extracted fields exist';
            END IF;
        END $$;
        """
    )

    op.execute(
        "DROP FUNCTION IF EXISTS "
        "identity.account_activation_organization_for_token(text);"
    )
    op.execute(
        "DROP FUNCTION IF EXISTS "
        "identity.auth_session_organization_for_family(uuid, uuid);"
    )
    op.execute(
        "DROP FUNCTION IF EXISTS identity.auth_session_organization_for_token(text);"
    )

    # Restore the exact 0024 auth-session behavior before removing the 0025
    # columns. Older migrations intentionally retain their historical contract.
    op.execute(
        "DROP POLICY IF EXISTS identity_auth_session_tenant_policy "
        "ON identity.auth_session;"
    )
    op.execute(
        "DROP POLICY IF EXISTS identity_auth_session_refresh_lookup "
        "ON identity.auth_session;"
    )
    op.execute(
        "DROP POLICY IF EXISTS identity_auth_session_tenant_write "
        "ON identity.auth_session;"
    )
    op.execute(
        "DROP POLICY IF EXISTS identity_auth_session_tenant_update "
        "ON identity.auth_session;"
    )
    op.execute(
        """
        CREATE POLICY identity_auth_session_refresh_lookup
            ON identity.auth_session FOR SELECT
            USING (true);
        CREATE POLICY identity_auth_session_tenant_write
            ON identity.auth_session FOR INSERT
            WITH CHECK (
                current_setting('labelscan.system_access', true) = 'true'
                OR organization_id::text =
                    current_setting('labelscan.organization_id', true)
            );
        CREATE POLICY identity_auth_session_tenant_update
            ON identity.auth_session FOR UPDATE
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
        """
    )

    for table in (
        "identity.app_user",
        "identity.store",
        "ingestion.ingestion",
        "ingestion.raw_artifact",
        "traceability.batch",
        "traceability.arrival_projection",
    ):
        _legacy_tenant_policy(table)

    for index in (
        "ix_arrival_projection_fields_trgm",
        "ix_arrival_projection_supplier_trgm",
        "ix_arrival_projection_lot_trgm",
        "ix_arrival_projection_org_portal_expiry",
        "ix_arrival_projection_org_portal_product",
        "ix_arrival_projection_org_portal_supplier",
        "ix_arrival_projection_org_portal_lot",
    ):
        op.execute(f"DROP INDEX IF EXISTS traceability.{index};")

    for table in (
        "haccp.alert",
        "identity.user_portal_assignment",
        "identity.business_portal",
    ):
        policy = table.replace(".", "_") + "_tenant_policy"
        op.execute(f"DROP POLICY IF EXISTS {policy} ON {table};")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY;")
    op.execute(
        "DROP POLICY IF EXISTS identity_account_activation_tenant_policy "
        "ON identity.account_activation;"
    )
    op.execute(
        "DROP POLICY IF EXISTS identity_account_activation_token_lookup "
        "ON identity.account_activation;"
    )
    op.execute(
        "DROP POLICY IF EXISTS identity_account_activation_tenant_insert "
        "ON identity.account_activation;"
    )
    op.execute(
        "DROP POLICY IF EXISTS identity_account_activation_tenant_update "
        "ON identity.account_activation;"
    )
    op.execute("ALTER TABLE identity.account_activation DISABLE ROW LEVEL SECURITY;")
    op.execute(
        "DROP POLICY IF EXISTS identity_profession_reference_read "
        "ON identity.profession;"
    )
    op.execute("ALTER TABLE identity.profession DISABLE ROW LEVEL SECURITY;")

    op.execute(
        """
        ALTER TABLE haccp.alert
            DROP COLUMN business_portal_id,
            DROP COLUMN store_id,
            DROP COLUMN organization_id;

        ALTER TABLE traceability.arrival_projection
            DROP COLUMN captured_by_user_id,
            DROP COLUMN trade_profile_version,
            DROP COLUMN trade_code_snapshot,
            DROP COLUMN business_portal_id;

        ALTER TABLE traceability.batch DROP CONSTRAINT uq_batch_lot;
        ALTER TABLE traceability.batch
            DROP COLUMN captured_by_user_id,
            DROP COLUMN trade_profile_version,
            DROP COLUMN trade_code_snapshot,
            DROP COLUMN business_portal_id,
            ADD CONSTRAINT uq_batch_lot UNIQUE NULLS NOT DISTINCT
                (organization_id, supplier_id, product_id, lot_code);

        ALTER TABLE ingestion.ingestion
            DROP COLUMN captured_by_user_id,
            DROP COLUMN trade_profile_version,
            DROP COLUMN trade_code_snapshot,
            DROP COLUMN business_portal_id;

        ALTER TABLE identity.auth_session DROP COLUMN client_type;
        DROP TABLE identity.account_activation;
        DROP TABLE identity.user_portal_assignment;
        DROP TABLE identity.business_portal;
        DROP TABLE identity.profession;

        ALTER TABLE identity.app_user
            DROP CONSTRAINT uq_app_user_organization_id,
            DROP CONSTRAINT ck_app_user_role,
            ADD CONSTRAINT ck_app_user_role
                CHECK (role IN ('admin', 'operator'));
        """
    )
    _set_extracted_field_names(_LEGACY_EXTRACTED_FIELD_NAMES)
