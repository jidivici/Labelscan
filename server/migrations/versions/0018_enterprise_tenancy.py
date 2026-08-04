"""enterprise multi-organization tenancy and current arrival projection

Revision ID: 0018_enterprise_tenancy
Revises: 0017_store_catalog
Create Date: 2026-07-26

Adds an explicit organization boundary while preserving every historical row.
Existing data is assigned to the deterministic ``labelscan`` organization.
Store codes and usernames become unique inside an organization rather than
globally. Tenant-owned tables receive PostgreSQL RLS policies as defence in depth.
"""

from __future__ import annotations

from alembic import op

revision = "0018_enterprise_tenancy"
down_revision = "0017_store_catalog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE identity.organization (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            slug        text        NOT NULL UNIQUE,
            name        text        NOT NULL,
            timezone    text        NOT NULL DEFAULT 'Europe/Paris',
            active      boolean     NOT NULL DEFAULT true,
            created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
            updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT ck_organization_slug CHECK (
                slug = lower(btrim(slug))
                AND slug ~ '^[a-z0-9][a-z0-9-]*$'
            ),
            CONSTRAINT ck_organization_name CHECK (btrim(name) <> '')
        );
        INSERT INTO identity.organization (slug, name)
        VALUES ('labelscan', 'LabelScan');
        """
    )

    op.execute(
        """
        ALTER TABLE identity.store
            ADD COLUMN organization_id uuid REFERENCES identity.organization(id),
            ADD COLUMN organization_code text;
        ALTER TABLE identity.store DISABLE TRIGGER trg_store_audit;
        UPDATE identity.store
        SET organization_id = (SELECT id FROM identity.organization WHERE slug = 'labelscan'),
            organization_code = 'labelscan';
        ALTER TABLE identity.store ENABLE TRIGGER trg_store_audit;
        ALTER TABLE identity.store
            ALTER COLUMN organization_id SET NOT NULL,
            ALTER COLUMN organization_code SET NOT NULL;
        """
    )
    op.execute(
        """
        ALTER TABLE identity.app_user
            ADD COLUMN organization_id uuid REFERENCES identity.organization(id),
            ADD COLUMN organization_code text,
            ADD COLUMN store_id uuid;
        ALTER TABLE identity.app_user DISABLE TRIGGER trg_app_user_audit;
        UPDATE identity.app_user AS u
        SET organization_id = (SELECT id FROM identity.organization WHERE slug = 'labelscan'),
            organization_code = 'labelscan',
            store_id = s.id
        FROM identity.store AS s
        WHERE s.code = u.store_code;
        UPDATE identity.app_user
        SET organization_id = (SELECT id FROM identity.organization WHERE slug = 'labelscan'),
            organization_code = 'labelscan'
        WHERE organization_id IS NULL;
        ALTER TABLE identity.app_user ENABLE TRIGGER trg_app_user_audit;
        ALTER TABLE identity.app_user
            ALTER COLUMN organization_id SET NOT NULL,
            ALTER COLUMN organization_code SET NOT NULL,
            ADD CONSTRAINT fk_app_user_store_id FOREIGN KEY (store_id)
                REFERENCES identity.store(id);
        """
    )

    # Replace global business identifiers by tenant-local identifiers. Retain the
    # legacy store_code column during the compatibility window.
    op.execute(
        """
        ALTER TABLE identity.app_user DROP CONSTRAINT fk_app_user_store_code;
        ALTER TABLE identity.store DROP CONSTRAINT store_code_key;
        ALTER TABLE identity.app_user DROP CONSTRAINT app_user_username_key;
        ALTER TABLE identity.store
            ADD CONSTRAINT uq_store_organization_code
                UNIQUE (organization_id, code),
            ADD CONSTRAINT uq_store_org_id_id
                UNIQUE (organization_id, id);
        ALTER TABLE identity.app_user
            ADD CONSTRAINT uq_user_organization_username
                UNIQUE (organization_id, username),
            ADD CONSTRAINT fk_app_user_organization_store
                FOREIGN KEY (organization_id, store_id)
                REFERENCES identity.store(organization_id, id);
        """
    )

    op.execute(
        """
        ALTER TABLE ingestion.ingestion
            ADD COLUMN organization_id uuid REFERENCES identity.organization(id),
            ADD COLUMN store_id uuid;
        ALTER TABLE ingestion.ingestion DISABLE TRIGGER trg_ingestion_audit_update;
        UPDATE ingestion.ingestion AS i
        SET organization_id = COALESCE(
                (SELECT s.organization_id FROM identity.store AS s
                 WHERE s.code = i.store_code),
                (SELECT id FROM identity.organization WHERE slug = 'labelscan')
            ),
            store_id = (
                SELECT s.id FROM identity.store AS s WHERE s.code = i.store_code
            );
        ALTER TABLE ingestion.ingestion ENABLE TRIGGER trg_ingestion_audit_update;
        ALTER TABLE ingestion.ingestion
            ALTER COLUMN organization_id SET NOT NULL,
            ADD CONSTRAINT fk_ingestion_organization_store
                FOREIGN KEY (organization_id, store_id)
                REFERENCES identity.store(organization_id, id);
        CREATE INDEX ix_ingestion_org_store_received
            ON ingestion.ingestion (organization_id, store_id, server_received_at DESC);
        """
    )
    op.execute(
        """
        ALTER TABLE traceability.batch
            ADD COLUMN organization_id uuid REFERENCES identity.organization(id),
            ADD COLUMN store_id uuid;
        ALTER TABLE traceability.batch DISABLE TRIGGER trg_batch_no_mutation;
        UPDATE traceability.batch AS b
        SET organization_id = i.organization_id,
            store_id = i.store_id
        FROM ingestion.ingestion AS i
        WHERE i.id = b.source_ingestion_id;
        UPDATE traceability.batch
        SET organization_id = (SELECT id FROM identity.organization WHERE slug = 'labelscan')
        WHERE organization_id IS NULL;
        ALTER TABLE traceability.batch
            ALTER COLUMN organization_id SET NOT NULL,
            ADD CONSTRAINT fk_batch_organization_store
                FOREIGN KEY (organization_id, store_id)
                REFERENCES identity.store(organization_id, id);
        ALTER TABLE traceability.batch ENABLE TRIGGER trg_batch_no_mutation;
        CREATE INDEX ix_batch_org_store_created
            ON traceability.batch (organization_id, store_id, created_at DESC);
        """
    )
    op.execute(
        """
        ALTER TABLE ingestion.raw_artifact
            ADD COLUMN organization_id uuid REFERENCES identity.organization(id);
        ALTER TABLE ingestion.raw_artifact DISABLE TRIGGER trg_raw_artifact_no_mutation;
        UPDATE ingestion.raw_artifact AS a
        SET organization_id = i.organization_id
        FROM ingestion.ingestion AS i
        WHERE i.id = a.ingestion_id;
        UPDATE ingestion.raw_artifact
        SET organization_id = (SELECT id FROM identity.organization WHERE slug = 'labelscan')
        WHERE organization_id IS NULL;
        ALTER TABLE ingestion.raw_artifact ALTER COLUMN organization_id SET NOT NULL;
        ALTER TABLE ingestion.raw_artifact ENABLE TRIGGER trg_raw_artifact_no_mutation;
        CREATE INDEX ix_raw_artifact_org_ingestion
            ON ingestion.raw_artifact (organization_id, ingestion_id);
        """
    )

    # The new review endpoint writes the complete human revision atomically. Reuse
    # the durable request-key ledger while preserving legacy per-field entries.
    op.execute(
        """
        ALTER TABLE ingestion.request_idempotency
            DROP CONSTRAINT request_idempotency_endpoint_check,
            ALTER COLUMN field_name DROP NOT NULL,
            ADD CONSTRAINT request_idempotency_endpoint_check
                CHECK (endpoint IN ('override_field', 'finalize_review'));
        """
    )

    # Current, replaceable catalogue projection. Immutable source runs and batches
    # remain the audit truth; this row only accelerates the latest read.
    op.execute(
        """
        CREATE TABLE traceability.arrival_projection (
            batch_id         uuid        PRIMARY KEY REFERENCES traceability.batch(id),
            organization_id  uuid        NOT NULL REFERENCES identity.organization(id),
            store_id         uuid,
            store_code       text,
            ingestion_id     uuid        NOT NULL REFERENCES ingestion.ingestion(id),
            extraction_run_id uuid       NOT NULL REFERENCES ingestion.extraction_run(id),
            revision_no      integer     NOT NULL DEFAULT 1,
            fields           jsonb       NOT NULL,
            image_ref        text        NOT NULL,
            image_checksum   text        NOT NULL,
            recorded_at      timestamptz NOT NULL,
            updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
            CONSTRAINT fk_arrival_projection_organization_store
                FOREIGN KEY (organization_id, store_id)
                REFERENCES identity.store(organization_id, id)
        );
        INSERT INTO traceability.arrival_projection (
            batch_id, organization_id, store_id, store_code, ingestion_id,
            extraction_run_id, fields, image_ref, image_checksum, recorded_at
        )
        SELECT
            b.id, b.organization_id, b.store_id, b.store_code,
            b.source_ingestion_id, b.source_extraction_run_id,
            COALESCE(fields.values, '{}'::jsonb),
            i.image_ref, i.checksum_sha256, b.created_at
        FROM traceability.batch AS b
        JOIN ingestion.ingestion AS i ON i.id = b.source_ingestion_id
        LEFT JOIN LATERAL (
            SELECT jsonb_object_agg(f.field_name, f.value) AS values
            FROM ingestion.extracted_field AS f
            WHERE f.extraction_run_id = b.source_extraction_run_id
        ) AS fields ON true;
        CREATE INDEX ix_arrival_projection_org_store_recorded
            ON traceability.arrival_projection
                (organization_id, store_id, recorded_at DESC);
        GRANT SELECT, INSERT, UPDATE ON traceability.arrival_projection TO labelscan_app;
        """
    )

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
        GRANT SELECT, INSERT, UPDATE ON identity.mobile_activation TO labelscan_app;
        GRANT SELECT ON identity.organization TO labelscan_app;
        """
    )

    # RLS uses transaction-local settings set by the repositories. Worker
    # transactions use labelscan.system_access=true for cross-tenant event relay.
    for table in (
        "identity.app_user",
        "identity.store",
        "identity.mobile_activation",
        "ingestion.ingestion",
        "ingestion.raw_artifact",
        "traceability.batch",
        "traceability.arrival_projection",
    ):
        policy = table.replace(".", "_")
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;")
        op.execute(
            f"""
            CREATE POLICY {policy}_tenant_policy ON {table}
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


def downgrade() -> None:
    for table in (
        "traceability.arrival_projection",
        "traceability.batch",
        "ingestion.raw_artifact",
        "ingestion.ingestion",
        "identity.mobile_activation",
        "identity.store",
        "identity.app_user",
    ):
        if table not in {"traceability.arrival_projection", "identity.mobile_activation"}:
            policy = table.replace(".", "_")
            op.execute(f"DROP POLICY IF EXISTS {policy}_tenant_policy ON {table};")
            op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY;")

    op.execute("DROP TABLE IF EXISTS traceability.arrival_projection;")
    op.execute("DROP TABLE IF EXISTS identity.mobile_activation;")
    op.execute(
        """
        DELETE FROM ingestion.request_idempotency
        WHERE endpoint = 'finalize_review';
        ALTER TABLE ingestion.request_idempotency
            DROP CONSTRAINT request_idempotency_endpoint_check,
            ALTER COLUMN field_name SET NOT NULL,
            ADD CONSTRAINT request_idempotency_endpoint_check
                CHECK (endpoint IN ('override_field'));
        """
    )
    op.execute("ALTER TABLE ingestion.raw_artifact DROP COLUMN organization_id;")
    op.execute(
        "ALTER TABLE traceability.batch DROP COLUMN store_id, DROP COLUMN organization_id;"
    )
    op.execute(
        "ALTER TABLE ingestion.ingestion DROP COLUMN store_id, DROP COLUMN organization_id;"
    )
    op.execute(
        """
        ALTER TABLE identity.app_user
            DROP CONSTRAINT fk_app_user_organization_store,
            DROP CONSTRAINT uq_user_organization_username,
            DROP CONSTRAINT fk_app_user_store_id,
            DROP COLUMN store_id,
            DROP COLUMN organization_code,
            DROP COLUMN organization_id,
            ADD CONSTRAINT app_user_username_key UNIQUE (username);
        ALTER TABLE identity.store
            DROP CONSTRAINT uq_store_org_id_id,
            DROP CONSTRAINT uq_store_organization_code,
            DROP COLUMN organization_code,
            DROP COLUMN organization_id,
            ADD CONSTRAINT store_code_key UNIQUE (code);
        ALTER TABLE identity.app_user
            ADD CONSTRAINT fk_app_user_store_code FOREIGN KEY (store_code)
                REFERENCES identity.store(code);
        """
    )
    op.execute("DROP TABLE IF EXISTS identity.organization;")
