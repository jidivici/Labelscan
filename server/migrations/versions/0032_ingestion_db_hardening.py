"""Harden the runtime DB role, ingestion constraints and child-table tenancy.

Revision ID: 0032_ingestion_db_hardening
Revises: 0031_photo_base_rotation
Create Date: 2026-08-20

This migration deliberately fails closed when Alembic is connected as the runtime
role or when that role is still privileged/owns application objects.  Production
must first transfer ownership to a distinct migration role.  Continuing in the
unsafe state would make grants and RLS cosmetic because PostgreSQL superusers and
table owners can bypass them.
"""

from __future__ import annotations

from alembic import op

revision = "0032_ingestion_db_hardening"
down_revision = "0031_photo_base_rotation"
branch_labels = None
depends_on = None

_SCHEMAS = (
    "ingestion",
    "compliance",
    "traceability",
    "haccp",
    "audit",
    "identity",
    "platform",
)

_DIRECT_TENANT_TABLES = (
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
)


def _assert_safe_role_split() -> None:
    ownership_schemas = ", ".join(f"'{schema}'" for schema in (*_SCHEMAS, "public"))
    op.execute(
        f"""
        DO $$
        DECLARE runtime_role record;
        BEGIN
            IF current_user = 'labelscan_app' THEN
                RAISE EXCEPTION
                    'unsafe migration connection: labelscan_app is the runtime role; use the separate DB migration owner';
            END IF;

            SELECT * INTO runtime_role
            FROM pg_roles WHERE rolname = 'labelscan_app';
            IF NOT FOUND THEN
                RAISE EXCEPTION 'required runtime role labelscan_app does not exist';
            END IF;
            IF runtime_role.rolsuper OR runtime_role.rolbypassrls
               OR runtime_role.rolcreatedb OR runtime_role.rolcreaterole
               OR runtime_role.rolreplication THEN
                RAISE EXCEPTION
                    'unsafe runtime role labelscan_app: SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION must all be disabled';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_roles privileged
                WHERE (
                    privileged.rolsuper OR privileged.rolbypassrls
                    OR privileged.rolcreatedb OR privileged.rolcreaterole
                    OR privileged.rolreplication
                )
                AND pg_has_role('labelscan_app', privileged.oid, 'member')
            ) THEN
                RAISE EXCEPTION
                    'unsafe runtime role labelscan_app: membership reaches an elevated role';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_class object
                JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
                WHERE namespace.nspname IN ({ownership_schemas})
                  AND pg_has_role('labelscan_app', object.relowner, 'member')
            ) THEN
                RAISE EXCEPTION
                    'unsafe runtime role labelscan_app: membership reaches an application object owner';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_proc function
                JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
                WHERE namespace.nspname IN ({ownership_schemas})
                  AND pg_has_role('labelscan_app', function.proowner, 'member')
            ) THEN
                RAISE EXCEPTION
                    'unsafe runtime role labelscan_app: membership reaches an application function owner';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_class object
                JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
                JOIN pg_roles owner ON owner.oid = object.relowner
                WHERE namespace.nspname IN ({ownership_schemas})
                  AND owner.rolname = 'labelscan_app'
            ) OR EXISTS (
                SELECT 1
                FROM pg_namespace namespace
                JOIN pg_roles owner ON owner.oid = namespace.nspowner
                WHERE namespace.nspname IN ({ownership_schemas})
                  AND owner.rolname = 'labelscan_app'
            ) THEN
                RAISE EXCEPTION
                    'unsafe runtime role labelscan_app owns application objects; REASSIGN OWNED to the migration role first';
            END IF;

            IF EXISTS (
                SELECT 1
                FROM pg_database database
                JOIN pg_roles owner ON owner.oid = database.datdba
                WHERE database.datname = current_database()
                  AND (
                      owner.rolname = 'labelscan_app'
                      OR pg_has_role('labelscan_app', owner.oid, 'member')
                  )
            ) THEN
                RAISE EXCEPTION
                    'unsafe runtime role labelscan_app owns (or can assume the owner of) the application database';
            END IF;
        END $$;
        """
    )


def _reset_runtime_privileges() -> None:
    # Remove inherited historical table grants, then rebuild the exact runtime
    # surface.  This is essential after ownership was transferred from a legacy
    # POSTGRES_USER=labelscan_app installation.
    for schema in _SCHEMAS:
        op.execute(
            f"REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA {schema} "
            "FROM labelscan_app;"
        )
        op.execute(f"REVOKE CREATE ON SCHEMA {schema} FROM PUBLIC, labelscan_app;")
        op.execute(f"GRANT USAGE ON SCHEMA {schema} TO labelscan_app;")

    op.execute(
        """
        DO $$
        BEGIN
            EXECUTE format(
                'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, labelscan_app',
                current_database()
            );
        END $$;
        """
    )
    op.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC, labelscan_app;")

    op.execute(
        "GRANT SELECT ON identity.organization, identity.profession TO labelscan_app;"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON "
        "identity.app_user, identity.store, identity.business_portal, "
        "identity.user_portal_assignment, identity.auth_session TO labelscan_app;"
    )
    op.execute(
        "GRANT SELECT, INSERT ON ingestion.ingestion TO labelscan_app; "
        "GRANT UPDATE (status, photo_rotation_degrees, photo_base_rotation_degrees) "
        "ON ingestion.ingestion TO labelscan_app;"
    )
    op.execute(
        "GRANT SELECT, INSERT ON ingestion.raw_artifact, ingestion.extraction_run, "
        "ingestion.extracted_field, ingestion.interim_field, "
        "ingestion.request_idempotency TO labelscan_app;"
    )
    op.execute(
        "GRANT SELECT, INSERT ON traceability.product, traceability.supplier, "
        "traceability.batch TO labelscan_app;"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON traceability.arrival_projection TO labelscan_app;"
    )
    op.execute(
        "GRANT SELECT, INSERT ON haccp.temperature_log, haccp.control_plan TO labelscan_app; "
        "GRANT SELECT, INSERT, UPDATE ON haccp.alert TO labelscan_app;"
    )
    op.execute("GRANT SELECT ON audit.audit_log TO labelscan_app;")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON platform.idempotency_key TO labelscan_app; "
        "GRANT SELECT, INSERT, UPDATE ON platform.outbox TO labelscan_app; "
        "GRANT SELECT, INSERT ON platform.processed_event TO labelscan_app;"
    )
    op.execute(
        "REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA identity, platform "
        "FROM PUBLIC, labelscan_app;"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION platform.default_organization_id() TO labelscan_app;"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION "
        "identity.auth_session_organization_for_token(text), "
        "identity.auth_session_organization_for_family(uuid, uuid) "
        "TO labelscan_app;"
    )


def _child_rls() -> None:
    op.execute(
        """
        ALTER TABLE ingestion.extraction_run ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ingestion.extraction_run FORCE ROW LEVEL SECURITY;
        CREATE POLICY ingestion_extraction_run_tenant_policy
        ON ingestion.extraction_run
        USING (EXISTS (
            SELECT 1 FROM ingestion.ingestion AS parent
            WHERE parent.id = extraction_run.ingestion_id
              AND parent.organization_id::text =
                  current_setting('labelscan.organization_id', true)
        ))
        WITH CHECK (EXISTS (
            SELECT 1 FROM ingestion.ingestion AS parent
            WHERE parent.id = extraction_run.ingestion_id
              AND parent.organization_id::text =
                  current_setting('labelscan.organization_id', true)
        ));

        ALTER TABLE ingestion.extracted_field ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ingestion.extracted_field FORCE ROW LEVEL SECURITY;
        CREATE POLICY ingestion_extracted_field_tenant_policy
        ON ingestion.extracted_field
        USING (EXISTS (
            SELECT 1
            FROM ingestion.extraction_run AS run
            JOIN ingestion.ingestion AS parent ON parent.id = run.ingestion_id
            WHERE run.id = extracted_field.extraction_run_id
              AND parent.organization_id::text =
                  current_setting('labelscan.organization_id', true)
        ))
        WITH CHECK (EXISTS (
            SELECT 1
            FROM ingestion.extraction_run AS run
            JOIN ingestion.ingestion AS parent ON parent.id = run.ingestion_id
            WHERE run.id = extracted_field.extraction_run_id
              AND parent.organization_id::text =
                  current_setting('labelscan.organization_id', true)
        ));

        ALTER TABLE ingestion.interim_field ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ingestion.interim_field FORCE ROW LEVEL SECURITY;
        CREATE POLICY ingestion_interim_field_tenant_policy
        ON ingestion.interim_field
        USING (EXISTS (
            SELECT 1 FROM ingestion.ingestion AS parent
            WHERE parent.id = interim_field.ingestion_id
              AND parent.organization_id::text =
                  current_setting('labelscan.organization_id', true)
        ))
        WITH CHECK (EXISTS (
            SELECT 1 FROM ingestion.ingestion AS parent
            WHERE parent.id = interim_field.ingestion_id
              AND parent.organization_id::text =
                  current_setting('labelscan.organization_id', true)
        ));

        ALTER TABLE ingestion.request_idempotency ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ingestion.request_idempotency FORCE ROW LEVEL SECURITY;
        CREATE POLICY ingestion_request_idempotency_tenant_policy
        ON ingestion.request_idempotency
        USING (EXISTS (
            SELECT 1 FROM ingestion.ingestion AS parent
            WHERE parent.id = request_idempotency.ingestion_id
              AND parent.organization_id::text =
                  current_setting('labelscan.organization_id', true)
        ))
        WITH CHECK (EXISTS (
            SELECT 1 FROM ingestion.ingestion AS parent
            WHERE parent.id = request_idempotency.ingestion_id
              AND parent.organization_id::text =
                  current_setting('labelscan.organization_id', true)
        ));
        """
    )


def _force_existing_rls() -> None:
    for table in _DIRECT_TENANT_TABLES:
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY;")


def _storage_constraints() -> None:
    op.execute(
        """
        ALTER TABLE ingestion.ingestion
            ADD CONSTRAINT ck_ingestion_checksum_sha256
                CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
            ADD CONSTRAINT ck_ingestion_image_ref_length
                CHECK (length(image_ref) BETWEEN 1 AND 1024),
            ADD CONSTRAINT ck_ingestion_barcode_length
                CHECK (barcode_raw IS NULL OR length(barcode_raw) <= 128);

        ALTER TABLE ingestion.raw_artifact
            ADD CONSTRAINT ck_raw_artifact_checksum_sha256
                CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
            ADD CONSTRAINT ck_raw_artifact_storage_ref_length
                CHECK (length(storage_ref) BETWEEN 1 AND 1024),
            ADD CONSTRAINT ck_raw_artifact_model_length
                CHECK (model IS NULL OR length(model) BETWEEN 1 AND 128);

        ALTER TABLE ingestion.extraction_run
            ADD CONSTRAINT uq_extraction_run_attempt
                UNIQUE (ingestion_id, attempt_no),
            ADD CONSTRAINT ck_extraction_run_attempt_positive
                CHECK (attempt_no > 0),
            ADD CONSTRAINT ck_extraction_run_metadata_lengths CHECK (
                length(extractor_version) BETWEEN 1 AND 128
                AND length(prompt_version) BETWEEN 1 AND 128
                AND length(ocr_provider) BETWEEN 1 AND 128
                AND length(llm_model) BETWEEN 1 AND 128
                AND length(rule_set_version) BETWEEN 1 AND 128
            );

        ALTER TABLE ingestion.extracted_field
            ADD CONSTRAINT ck_extracted_field_value_shape CHECK (
                value IS NULL OR (
                    jsonb_typeof(value) = 'string'
                    AND length(value #>> '{}') <= 512
                )
            ),
            ADD CONSTRAINT ck_extracted_field_evidence_shape CHECK (
                evidence IS NULL OR (
                    jsonb_typeof(evidence) = 'array'
                    AND jsonb_array_length(evidence) BETWEEN 1 AND 16
                    AND length(evidence::text) <= 32768
                )
            ),
            ADD CONSTRAINT ck_extracted_field_provenance_shape CHECK (
                provenance IS NULL OR (
                    jsonb_typeof(provenance) = 'object'
                    AND length(provenance::text) <= 8192
                )
            ),
            ADD CONSTRAINT ck_extracted_field_warnings_shape CHECK (
                jsonb_typeof(warnings) = 'array'
                AND jsonb_array_length(warnings) <= 16
                AND length(warnings::text) <= 16384
            ),
            ADD CONSTRAINT ck_extracted_field_confidence_ranges CHECK (
                (llm_confidence IS NULL OR llm_confidence BETWEEN 0 AND 1)
                AND (ocr_confidence IS NULL OR ocr_confidence BETWEEN 0 AND 1)
                AND combined_confidence BETWEEN 0 AND 1
            );

        ALTER TABLE ingestion.request_idempotency
            ADD CONSTRAINT ck_request_idempotency_key_length
                CHECK (length(idempotency_key) BETWEEN 1 AND 128),
            ADD CONSTRAINT ck_request_idempotency_finalize_hash CHECK (
                endpoint <> 'finalize_review' OR request_hash IS NOT NULL
            );
        """
    )


def upgrade() -> None:
    _assert_safe_role_split()
    _reset_runtime_privileges()
    _child_rls()
    _force_existing_rls()
    _storage_constraints()


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE ingestion.request_idempotency
            DROP CONSTRAINT IF EXISTS ck_request_idempotency_finalize_hash,
            DROP CONSTRAINT IF EXISTS ck_request_idempotency_key_length;
        ALTER TABLE ingestion.extracted_field
            DROP CONSTRAINT IF EXISTS ck_extracted_field_confidence_ranges,
            DROP CONSTRAINT IF EXISTS ck_extracted_field_warnings_shape,
            DROP CONSTRAINT IF EXISTS ck_extracted_field_provenance_shape,
            DROP CONSTRAINT IF EXISTS ck_extracted_field_evidence_shape,
            DROP CONSTRAINT IF EXISTS ck_extracted_field_value_shape;
        ALTER TABLE ingestion.extraction_run
            DROP CONSTRAINT IF EXISTS ck_extraction_run_metadata_lengths,
            DROP CONSTRAINT IF EXISTS ck_extraction_run_attempt_positive,
            DROP CONSTRAINT IF EXISTS uq_extraction_run_attempt;
        ALTER TABLE ingestion.raw_artifact
            DROP CONSTRAINT IF EXISTS ck_raw_artifact_model_length,
            DROP CONSTRAINT IF EXISTS ck_raw_artifact_storage_ref_length,
            DROP CONSTRAINT IF EXISTS ck_raw_artifact_checksum_sha256;
        ALTER TABLE ingestion.ingestion
            DROP CONSTRAINT IF EXISTS ck_ingestion_barcode_length,
            DROP CONSTRAINT IF EXISTS ck_ingestion_image_ref_length,
            DROP CONSTRAINT IF EXISTS ck_ingestion_checksum_sha256;
        """
    )
    for table in reversed(_DIRECT_TENANT_TABLES):
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY;")
    for table in (
        "ingestion.request_idempotency",
        "ingestion.interim_field",
        "ingestion.extracted_field",
        "ingestion.extraction_run",
    ):
        policy = table.replace(".", "_") + "_tenant_policy"
        op.execute(f"DROP POLICY IF EXISTS {policy} ON {table};")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY;")
