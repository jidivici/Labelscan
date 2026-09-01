"""Catalog-level regression proofs for the consolidated PostgreSQL baseline."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from labelscan.platform.db.audit_context import set_audit_context
from tests.conftest import ACTOR_ID

APP_SCHEMAS = (
    "audit",
    "compliance",
    "haccp",
    "identity",
    "ingestion",
    "platform",
    "traceability",
)

EXPECTED_LOGICAL_TABLES = {
    "audit.catalog_export_log",
    "audit.audit_log",
    "haccp.alert",
    "haccp.control_plan",
    "haccp.temperature_log",
    "identity.app_user",
    "identity.auth_session",
    "identity.business_portal",
    "identity.organization",
    "identity.profession",
    "identity.store",
    "identity.user_portal_assignment",
    "ingestion.extracted_field",
    "ingestion.extraction_run",
    "ingestion.ingestion",
    "ingestion.interim_field",
    "ingestion.raw_artifact",
    "ingestion.request_idempotency",
    "platform.idempotency_key",
    "platform.outbox",
    "platform.processed_event",
    "traceability.arrival_projection",
    "traceability.batch",
    "traceability.product",
    "traceability.supplier",
}

EXPECTED_PARTITIONS = {
    "audit.audit_log_2026_06": "audit.audit_log",
    "audit.audit_log_2026_07": "audit.audit_log",
    "audit.audit_log_default": "audit.audit_log",
    "haccp.temperature_log_2026_06": "haccp.temperature_log",
    "haccp.temperature_log_2026_07": "haccp.temperature_log",
    "haccp.temperature_log_default": "haccp.temperature_log",
    "ingestion.raw_artifact_2026_06": "ingestion.raw_artifact",
    "ingestion.raw_artifact_2026_07": "ingestion.raw_artifact",
    "ingestion.raw_artifact_default": "ingestion.raw_artifact",
}

EXPECTED_RLS_POLICIES = {
    (
        "audit.catalog_export_log",
        "catalog_export_log_tenant_policy",
        "ALL",
    ),
    ("haccp.alert", "haccp_alert_tenant_policy", "ALL"),
    ("identity.app_user", "identity_app_user_tenant_policy", "ALL"),
    ("identity.auth_session", "identity_auth_session_tenant_policy", "ALL"),
    ("identity.business_portal", "identity_business_portal_tenant_policy", "ALL"),
    ("identity.profession", "identity_profession_reference_read", "SELECT"),
    ("identity.store", "identity_store_tenant_policy", "ALL"),
    (
        "identity.user_portal_assignment",
        "identity_user_portal_assignment_tenant_policy",
        "ALL",
    ),
    (
        "ingestion.extracted_field",
        "ingestion_extracted_field_tenant_policy",
        "ALL",
    ),
    (
        "ingestion.extraction_run",
        "ingestion_extraction_run_tenant_policy",
        "ALL",
    ),
    ("ingestion.ingestion", "ingestion_ingestion_tenant_policy", "ALL"),
    ("ingestion.interim_field", "ingestion_interim_field_tenant_policy", "ALL"),
    ("ingestion.raw_artifact", "ingestion_raw_artifact_tenant_policy", "ALL"),
    (
        "ingestion.request_idempotency",
        "ingestion_request_idempotency_tenant_policy",
        "ALL",
    ),
    (
        "traceability.arrival_projection",
        "traceability_arrival_projection_tenant_policy",
        "ALL",
    ),
    ("traceability.batch", "traceability_batch_tenant_policy", "ALL"),
}

EXPECTED_FORCED_RLS = {
    relation
    for relation, _, command in EXPECTED_RLS_POLICIES
    if command == "ALL" and relation != "identity.profession"
}

EXPECTED_TABLE_GRANTS = {
    ("labelscan_app", "audit.catalog_export_log"): {"SELECT"},
    ("labelscan_app", "audit.audit_log"): {"SELECT"},
    ("labelscan_app", "haccp.alert"): {"INSERT", "SELECT", "UPDATE"},
    ("labelscan_app", "haccp.control_plan"): {"INSERT", "SELECT"},
    ("labelscan_app", "haccp.temperature_log"): {"INSERT", "SELECT"},
    ("labelscan_app", "identity.app_user"): {"INSERT", "SELECT", "UPDATE"},
    ("labelscan_app", "identity.auth_session"): {"INSERT", "SELECT", "UPDATE"},
    ("labelscan_app", "identity.business_portal"): {
        "INSERT",
        "SELECT",
        "UPDATE",
    },
    ("labelscan_app", "identity.organization"): {"SELECT"},
    ("labelscan_app", "identity.profession"): {"SELECT"},
    ("labelscan_app", "identity.store"): {"INSERT", "SELECT", "UPDATE"},
    ("labelscan_app", "identity.user_portal_assignment"): {
        "INSERT",
        "SELECT",
        "UPDATE",
    },
    ("labelscan_app", "ingestion.extracted_field"): {"INSERT", "SELECT"},
    ("labelscan_app", "ingestion.extraction_run"): {"INSERT", "SELECT"},
    ("labelscan_app", "ingestion.ingestion"): {"INSERT", "SELECT"},
    ("labelscan_app", "ingestion.interim_field"): {"INSERT", "SELECT"},
    ("labelscan_app", "ingestion.raw_artifact"): {"INSERT", "SELECT"},
    ("labelscan_app", "ingestion.request_idempotency"): {"INSERT", "SELECT"},
    ("labelscan_app", "platform.idempotency_key"): {
        "INSERT",
        "SELECT",
        "UPDATE",
    },
    ("labelscan_app", "platform.outbox"): {"INSERT", "SELECT", "UPDATE"},
    ("labelscan_app", "platform.processed_event"): {"INSERT", "SELECT"},
    ("labelscan_app", "traceability.arrival_projection"): {
        "INSERT",
        "SELECT",
        "UPDATE",
    },
    ("labelscan_app", "traceability.batch"): {"INSERT", "SELECT"},
    ("labelscan_app", "traceability.product"): {"INSERT", "SELECT"},
    ("labelscan_app", "traceability.supplier"): {"INSERT", "SELECT"},
    ("labelscan_auditor", "audit.audit_log"): {"INSERT"},
    ("labelscan_auditor", "audit.catalog_export_log"): {"INSERT"},
}


def _group_grants(rows):
    grouped: dict[tuple[str, str], set[str]] = {}
    for grantee, relation, privilege in rows:
        grouped.setdefault((grantee, relation), set()).add(privilege)
    return grouped


def test_consolidated_baseline_preserves_the_complete_catalog(conn) -> None:
    assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == (
        "0035_catalog_export_audit"
    )

    logical_tables = set(
        conn.execute(
            text(
                """
                SELECT namespace.nspname || '.' || relation.relname
                FROM pg_class AS relation
                JOIN pg_namespace AS namespace
                  ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = ANY(:schemas)
                  AND relation.relkind IN ('r', 'p')
                  AND NOT relation.relispartition
                """
            ),
            {"schemas": list(APP_SCHEMAS)},
        ).scalars()
    )
    assert logical_tables == EXPECTED_LOGICAL_TABLES

    partitions = dict(
        conn.execute(
            text(
                """
                SELECT child_namespace.nspname || '.' || child.relname,
                       parent_namespace.nspname || '.' || parent.relname
                FROM pg_inherits AS inheritance
                JOIN pg_class AS child ON child.oid = inheritance.inhrelid
                JOIN pg_namespace AS child_namespace
                  ON child_namespace.oid = child.relnamespace
                JOIN pg_class AS parent ON parent.oid = inheritance.inhparent
                JOIN pg_namespace AS parent_namespace
                  ON parent_namespace.oid = parent.relnamespace
                WHERE child_namespace.nspname = ANY(:schemas)
                  AND child.relispartition
                  AND child.relkind IN ('r', 'p')
                """
            ),
            {"schemas": list(APP_SCHEMAS)},
        )
        .tuples()
        .all()
    )
    assert partitions == EXPECTED_PARTITIONS

    policy_rows = conn.execute(
        text(
            """
            SELECT schemaname || '.' || tablename, policyname, cmd,
                   permissive, roles, qual, with_check
            FROM pg_policies
            WHERE schemaname = ANY(:schemas)
            """
        ),
        {"schemas": list(APP_SCHEMAS)},
    ).all()
    assert {(row[0], row[1], row[2]) for row in policy_rows} == EXPECTED_RLS_POLICIES
    assert all(row.permissive == "PERMISSIVE" and row.roles == ["public"] for row in policy_rows)
    tenant_policies = [row for row in policy_rows if row.cmd == "ALL"]
    assert all("labelscan.organization_id" in row.qual for row in tenant_policies)
    assert all("labelscan.organization_id" in row.with_check for row in tenant_policies)

    forced_rls = set(
        conn.execute(
            text(
                """
                SELECT namespace.nspname || '.' || relation.relname
                FROM pg_class AS relation
                JOIN pg_namespace AS namespace
                  ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = ANY(:schemas)
                  AND relation.relforcerowsecurity
                """
            ),
            {"schemas": list(APP_SCHEMAS)},
        ).scalars()
    )
    assert forced_rls == EXPECTED_FORCED_RLS

    trigger_counts = dict(
        conn.execute(
            text(
                """
                SELECT procedure.proname, count(*)
                FROM pg_trigger AS trigger
                JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
                JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
                JOIN pg_namespace AS namespace
                  ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = ANY(:schemas)
                  AND NOT trigger.tgisinternal
                GROUP BY procedure.proname
                """
            ),
            {"schemas": list(APP_SCHEMAS)},
        )
        .tuples()
        .all()
    )
    assert trigger_counts == {"audit_on_insert": 19, "deny_mutation": 32}

    partition_triggers = {
        (row.relation, row.tgname)
        for row in conn.execute(
            text(
                """
                SELECT namespace.nspname || '.' || relation.relname AS relation,
                       trigger.tgname
                FROM pg_trigger AS trigger
                JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
                JOIN pg_namespace AS namespace
                  ON namespace.oid = relation.relnamespace
                WHERE relation.relispartition
                  AND NOT trigger.tgisinternal
                """
            )
        )
    }
    for partition, parent in EXPECTED_PARTITIONS.items():
        if parent == "audit.audit_log":
            expected = {"trg_audit_log_no_mutation"}
        elif parent == "haccp.temperature_log":
            expected = {
                "trg_temperature_log_audit",
                "trg_temperature_log_no_mutation",
            }
        else:
            expected = {"trg_raw_artifact_audit", "trg_raw_artifact_no_mutation"}
        assert {name for relation, name in partition_triggers if relation == partition} == expected

    functions = {
        (row.schema_name, row.proname): row
        for row in conn.execute(
            text(
                """
                SELECT namespace.nspname AS schema_name, procedure.proname,
                       owner.rolname AS owner, procedure.prosecdef,
                       procedure.proconfig, procedure.proacl
                FROM pg_proc AS procedure
                JOIN pg_namespace AS namespace
                  ON namespace.oid = procedure.pronamespace
                JOIN pg_roles AS owner ON owner.oid = procedure.proowner
                WHERE namespace.nspname = ANY(:schemas)
                """
            ),
            {"schemas": list(APP_SCHEMAS)},
        )
    }
    assert set(functions) == {
        ("identity", "auth_session_organization_for_family"),
        ("identity", "auth_session_organization_for_token"),
        ("platform", "audit_on_insert"),
        ("platform", "default_organization_id"),
        ("platform", "deny_mutation"),
        ("platform", "record_catalog_export"),
    }
    audit_function = functions[("platform", "audit_on_insert")]
    assert audit_function.owner == "labelscan_auditor"
    assert audit_function.prosecdef is True
    assert set(audit_function.proconfig or ()) == {'search_path=""'}
    export_function = functions[("platform", "record_catalog_export")]
    assert export_function.owner == "labelscan_auditor"
    assert export_function.prosecdef is True
    assert set(export_function.proconfig or ()) == {'search_path=""'}

    public_function_grants = conn.execute(
        text(
            """
            SELECT count(*)
            FROM pg_proc AS procedure
            JOIN pg_namespace AS namespace
              ON namespace.oid = procedure.pronamespace
            CROSS JOIN LATERAL aclexplode(COALESCE(
                procedure.proacl, acldefault('f', procedure.proowner)
            )) AS acl
            WHERE namespace.nspname = ANY(:schemas)
              AND acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
            """
        ),
        {"schemas": list(APP_SCHEMAS)},
    ).scalar_one()
    assert public_function_grants == 0

    table_grants = _group_grants(
        conn.execute(
            text(
                """
                SELECT grantee, table_schema || '.' || table_name, privilege_type
                FROM information_schema.role_table_grants
                WHERE grantee IN ('labelscan_app', 'labelscan_auditor')
                  AND table_schema = ANY(:schemas)
                """
            ),
            {"schemas": list(APP_SCHEMAS)},
        )
    )
    assert table_grants == EXPECTED_TABLE_GRANTS

    role_flags = conn.execute(
        text(
            """
            SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin,
                   rolreplication, rolbypassrls
            FROM pg_roles
            WHERE rolname IN ('labelscan_app', 'labelscan_auditor')
            ORDER BY rolname
            """
        )
    ).all()
    assert [row.rolname for row in role_flags] == [
        "labelscan_app",
        "labelscan_auditor",
    ]
    assert all(not any(row[1:]) for row in role_flags)
    for role_name in ("labelscan_app", "labelscan_auditor"):
        assert conn.execute(
            text(
                "SELECT has_database_privilege(:role, current_database(), 'CREATE')"
            ),
            {"role": role_name},
        ).scalar_one() is False
        assert conn.execute(
            text(
                "SELECT has_database_privilege(:role, current_database(), 'TEMPORARY')"
            ),
            {"role": role_name},
        ).scalar_one() is False
        assert conn.execute(
            text("SELECT has_schema_privilege(:role, 'public', 'CREATE')"),
            {"role": role_name},
        ).scalar_one() is False

    seeds = conn.execute(
        text(
            """
            SELECT code, name, active
            FROM identity.profession
            ORDER BY code
            """
        )
    ).all()
    assert seeds == [
        ("boucherie", "Boucherie", True),
        ("charcuterie_traiteur", "Charcuterie–Traiteur", True),
        ("poissonnerie", "Poissonnerie", True),
    ]
    assert conn.execute(
        text(
            """
            SELECT slug, name, timezone, active
            FROM identity.organization
            """
        )
    ).one() == ("labelscan", "LabelScan", "Europe/Paris", True)


def test_sanitized_image_constraint_covers_every_partition(conn) -> None:
    definitions = conn.execute(
        text(
            """
            SELECT relation.relname, pg_get_constraintdef(con.oid, true),
                   con.convalidated
            FROM pg_constraint AS con
            JOIN pg_class AS relation ON relation.oid = con.conrelid
            JOIN pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'ingestion'
              AND relation.relname LIKE 'raw_artifact%'
              AND con.conname = 'ck_raw_artifact_kind'
            ORDER BY relation.relname
            """
        )
    ).all()
    assert [row.relname for row in definitions] == [
        "raw_artifact",
        "raw_artifact_2026_06",
        "raw_artifact_2026_07",
        "raw_artifact_default",
    ]
    assert all(row.convalidated for row in definitions)
    assert all("'sanitized_image'::text" in row[1] for row in definitions)


def test_sanitized_image_is_accepted_and_unknown_kinds_are_rejected(conn) -> None:
    transaction = conn.begin()
    try:
        organization_id = str(
            conn.execute(
                text("SELECT id FROM identity.organization WHERE slug = 'labelscan'")
            ).scalar_one()
        )
        conn.execute(
            text("SELECT set_config('labelscan.organization_id', :value, true)"),
            {"value": organization_id},
        )
        set_audit_context(
            conn,
            actor_id=ACTOR_ID,
            action="migration.sanitized_image_test",
            correlation_id="migration-0034-test",
            trace_id="migration-0034-test",
        )
        artifact_kind = conn.execute(
            text(
                """
                INSERT INTO ingestion.raw_artifact (
                    ingestion_id, artifact_kind, storage_ref, checksum_sha256,
                    correlation_id, trace_id
                ) VALUES (
                    :ingestion_id, 'sanitized_image', 's3://sanitized/test',
                    :checksum, 'migration-0034-test', 'migration-0034-test'
                )
                RETURNING artifact_kind
                """
            ),
            {"ingestion_id": str(uuid.uuid4()), "checksum": "a" * 64},
        ).scalar_one()
        assert artifact_kind == "sanitized_image"
        assert conn.execute(
            text(
                "SELECT count(*) FROM audit.audit_log "
                "WHERE action = 'migration.sanitized_image_test'"
            )
        ).scalar_one() == 1
    finally:
        transaction.rollback()

    transaction = conn.begin()
    try:
        organization_id = str(
            conn.execute(
                text("SELECT id FROM identity.organization WHERE slug = 'labelscan'")
            ).scalar_one()
        )
        conn.execute(
            text("SELECT set_config('labelscan.organization_id', :value, true)"),
            {"value": organization_id},
        )
        set_audit_context(
            conn,
            actor_id=ACTOR_ID,
            action="migration.invalid_artifact_test",
            correlation_id="migration-0034-invalid",
            trace_id="migration-0034-invalid",
        )
        with pytest.raises(DBAPIError):
            conn.execute(
                text(
                    """
                    INSERT INTO ingestion.raw_artifact (
                        ingestion_id, artifact_kind, storage_ref,
                        checksum_sha256, correlation_id, trace_id
                    ) VALUES (
                        :ingestion_id, 'decoded_but_untrusted', 's3://invalid/test',
                        :checksum, 'migration-0034-invalid',
                        'migration-0034-invalid'
                    )
                    """
                ),
                {"ingestion_id": str(uuid.uuid4()), "checksum": "b" * 64},
            )
    finally:
        transaction.rollback()
