"""Database contract proofs for the additive multi-trade migration."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from labelscan.platform.db.audit_context import set_audit_context
from tests.conftest import ACTOR_ID

MULTI_TRADE_EXTRACTED_FIELDS = (
    # Legacy compatibility, including the v1 names no longer emitted.
    "product_name",
    "supplier_name",
    # Poissonnerie.
    "scientific_name",
    "FAO_area",
    "production_method",
    "fishing_gear_or_farming_method",
    # Boucherie (animal_category/cutting_country are in profile v1).
    "animal_species",
    "animal_category",
    "cut_name",
    "birth_country",
    "rearing_country",
    "slaughter_country",
    "cutting_country",
    "slaughterhouse_approval",
    "cutting_plant_approval",
    # Charcuterie–Traiteur.
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


def test_multi_trade_schema_contract(conn):
    with conn.begin():
        professions = tuple(
            conn.execute(
                text("SELECT code FROM identity.profession ORDER BY code")
            ).scalars()
        )
        assert professions == (
            "boucherie",
            "charcuterie_traiteur",
            "poissonnerie",
        )

        columns: dict[tuple[str, str], set[str]] = {}
        for row in conn.execute(
            text(
                """
                    SELECT table_schema, table_name, column_name
                    FROM information_schema.columns
                    WHERE (table_schema, table_name) IN (
                        ('identity', 'business_portal'),
                        ('identity', 'user_portal_assignment'),
                        ('identity', 'account_activation'),
                        ('ingestion', 'ingestion'),
                        ('traceability', 'batch'),
                        ('traceability', 'arrival_projection'),
                        ('haccp', 'alert'),
                        ('identity', 'auth_session')
                    )
                    ORDER BY table_schema, table_name, ordinal_position
                    """
            )
        ):
            columns.setdefault((row.table_schema, row.table_name), set()).add(
                row.column_name
            )
        ownership = {
            "business_portal_id",
            "trade_code_snapshot",
            "trade_profile_version",
            "captured_by_user_id",
        }
        assert ownership <= columns[("ingestion", "ingestion")]
        assert ownership <= columns[("traceability", "batch")]
        assert ownership <= columns[("traceability", "arrival_projection")]
        assert {"organization_id", "store_id", "business_portal_id"} <= columns[
            ("haccp", "alert")
        ]
        assert "client_type" in columns[("identity", "auth_session")]
        assert {
            "organization_id",
            "user_id",
            "token_hash",
            "purpose",
            "expires_at",
            "used_at",
            "created_by",
        } <= columns[("identity", "account_activation")]
        assert {"id", "active", "updated_at"} <= columns[
            ("identity", "user_portal_assignment")
        ]

        rls_tables = {
            f"{row.nspname}.{row.relname}"
            for row in conn.execute(
                text(
                    """
                    SELECT namespace.nspname, relation.relname
                    FROM pg_class AS relation
                    JOIN pg_namespace AS namespace
                      ON namespace.oid = relation.relnamespace
                    WHERE relation.relrowsecurity
                    """
                )
            )
        }
        assert {
            "identity.profession",
            "identity.business_portal",
            "identity.user_portal_assignment",
            "identity.account_activation",
            "haccp.alert",
        } <= rls_tables

        constraint_names = set(
            conn.execute(
                text(
                    """
                    SELECT constraint_name
                    FROM information_schema.table_constraints
                    WHERE constraint_schema IN ('identity', 'ingestion', 'traceability', 'haccp')
                    """
                )
            ).scalars()
        )
        assert {
            "uq_business_portal_store_profession",
            "fk_user_portal_assignment_user",
            "fk_user_portal_assignment_portal",
            "fk_account_activation_user",
            "fk_account_activation_creator",
            "fk_ingestion_business_portal",
            "fk_batch_business_portal",
            "fk_arrival_projection_business_portal",
            "fk_alert_business_portal",
            "ck_auth_session_client_type",
        } <= constraint_names

        assignment_audit_trigger = conn.execute(
            text(
                """
                SELECT count(*)
                FROM pg_trigger AS trigger
                JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
                JOIN pg_namespace AS namespace
                  ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = 'identity'
                  AND relation.relname = 'user_portal_assignment'
                  AND trigger.tgname = 'trg_user_portal_assignment_audit'
                  AND NOT trigger.tgisinternal
                """
            )
        ).scalar_one()
        assert assignment_audit_trigger == 1

        assignment_grants = set(
            conn.execute(
                text(
                    """
                    SELECT privilege_type
                    FROM information_schema.role_table_grants
                    WHERE grantee = 'labelscan_app'
                      AND table_schema = 'identity'
                      AND table_name = 'user_portal_assignment'
                    """
                )
            ).scalars()
        )
        assert assignment_grants == {"SELECT", "INSERT", "UPDATE"}

        index_names = set(
            conn.execute(
                text(
                    "SELECT indexname FROM pg_indexes "
                    "WHERE schemaname = 'traceability' "
                    "AND tablename = 'arrival_projection'"
                )
            ).scalars()
        )
        assert {
            "ix_arrival_projection_fields_trgm",
            "ix_arrival_projection_supplier_trgm",
            "ix_arrival_projection_lot_trgm",
            "ix_arrival_projection_org_portal_recorded",
            "ix_arrival_projection_org_portal_expiry",
            "ix_arrival_projection_org_portal_product",
            "ix_arrival_projection_org_portal_supplier",
            "ix_arrival_projection_org_portal_lot",
        } <= index_names

        lookup_functions = (
            conn.execute(
                text(
                    """
                    SELECT procedure.proname,
                           procedure.prosecdef,
                           procedure.proconfig,
                           has_function_privilege(
                               'labelscan_app', procedure.oid, 'EXECUTE'
                           ) AS app_can_execute,
                           EXISTS (
                               SELECT 1
                               FROM aclexplode(COALESCE(
                                   procedure.proacl,
                                   acldefault('f', procedure.proowner)
                               )) AS acl
                               WHERE acl.grantee = 0
                                 AND acl.privilege_type = 'EXECUTE'
                           ) AS public_can_execute
                    FROM pg_proc AS procedure
                    JOIN pg_namespace AS namespace
                      ON namespace.oid = procedure.pronamespace
                    WHERE namespace.nspname = 'identity'
                      AND procedure.proname IN (
                          'auth_session_organization_for_token',
                          'auth_session_organization_for_family',
                          'account_activation_organization_for_token'
                      )
                    ORDER BY procedure.proname
                    """
                )
            )
            .mappings()
            .all()
        )
        assert len(lookup_functions) == 3
        for function in lookup_functions:
            assert function["prosecdef"] is True
            assert function["app_can_execute"] is True
            assert function["public_can_execute"] is False
            settings = set(function["proconfig"] or ())
            assert "search_path=pg_catalog, identity" in settings
            assert "row_security=off" in settings


def test_account_activation_rejects_clear_token_storage(conn):
    transaction = conn.begin()
    try:
        organization_id = conn.execute(
            text("SELECT id FROM identity.organization WHERE slug = 'labelscan'")
        ).scalar_one()
        user_id = str(uuid.uuid4())
        correlation_id = f"activation-schema-{uuid.uuid4().hex}"
        set_audit_context(
            conn,
            actor_id=ACTOR_ID,
            action="identity.activation_schema_test",
            correlation_id=correlation_id,
            trace_id=correlation_id,
        )
        conn.execute(
            text(
                """
                INSERT INTO identity.app_user (
                    id, organization_id, organization_code, username,
                    display_name, password_hash, role, active, created_by
                )
                VALUES (
                    :id, :organization_id, 'labelscan', :username,
                    'Activation schema test', 'not-a-real-password-hash',
                    'admin', true, :id
                )
                """
            ),
            {
                "id": user_id,
                "organization_id": organization_id,
                "username": f"activation-schema-{uuid.uuid4().hex}",
            },
        )

        with pytest.raises(IntegrityError), conn.begin_nested():
            conn.execute(
                text(
                    """
                    INSERT INTO identity.account_activation (
                        organization_id, user_id, token_hash, purpose,
                        expires_at, created_by
                    )
                    VALUES (
                        :organization_id, :user_id, 'clear-token-must-never-persist',
                        'initial', now() + interval '1 hour', :user_id
                    )
                    """
                ),
                {"organization_id": organization_id, "user_id": user_id},
            )
    finally:
        transaction.rollback()


def test_extracted_field_accepts_all_trade_profile_fields(conn):
    transaction = conn.begin()
    try:
        run_id = str(uuid.uuid4())
        correlation_id = f"multi-trade-fields-{uuid.uuid4().hex}"
        set_audit_context(
            conn,
            actor_id=ACTOR_ID,
            action="ingestion.multi_trade_schema_test",
            correlation_id=correlation_id,
            trace_id=correlation_id,
        )
        conn.execute(
            text(
                """
                INSERT INTO ingestion.extraction_run (
                    id, ingestion_id, attempt_no, outcome, extractor_version,
                    prompt_version, ocr_provider, llm_model, rule_set_version,
                    correlation_id, trace_id
                )
                VALUES (
                    :id, :ingestion_id, 1, 'extracted', 'schema-test',
                    'schema-test', 'schema-test', 'schema-test', 'schema-test',
                    :correlation_id, :correlation_id
                )
                """
            ),
            {
                "id": run_id,
                "ingestion_id": str(uuid.uuid4()),
                "correlation_id": correlation_id,
            },
        )
        for field_name in MULTI_TRADE_EXTRACTED_FIELDS:
            conn.execute(
                text(
                    """
                    INSERT INTO ingestion.extracted_field (
                        extraction_run_id, field_name, value, evidence,
                        validation_status, warnings, combined_confidence,
                        confidence_band, source
                    )
                    VALUES (
                        :run_id, :field_name, NULL, NULL, 'missing', '[]'::jsonb,
                        0, 'low', 'llm'
                    )
                    """
                ),
                {"run_id": run_id, "field_name": field_name},
            )

        stored = conn.execute(
            text(
                "SELECT field_name FROM ingestion.extracted_field "
                "WHERE extraction_run_id = :run_id"
            ),
            {"run_id": run_id},
        ).scalars()
        assert set(stored) == set(MULTI_TRADE_EXTRACTED_FIELDS)
    finally:
        transaction.rollback()
