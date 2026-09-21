"""PostgreSQL contract for the append-only, tenant-scoped export audit."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.tenant_context import set_tenant_context
from tests.conftest import ACTOR_ID


def _organization_id(engine) -> str:
    with engine.connect() as conn:
        return str(
            conn.execute(
                text("SELECT id FROM identity.organization WHERE slug = 'labelscan'")
            ).scalar_one()
        )


def _record_as_runtime(conn, organization_id: str) -> str:
    correlation_id = f"export-audit-{uuid.uuid4()}"
    conn.execute(text("SET LOCAL ROLE labelscan_app"))
    set_tenant_context(conn, organization_id)
    set_audit_context(
        conn,
        actor_id=ACTOR_ID,
        action="catalog.exported",
        correlation_id=correlation_id,
        trace_id=uuid.uuid4().hex,
    )
    conn.execute(
        text(
            "SELECT platform.record_catalog_export("
            "'json', 1, :filter_sha256)"
        ),
        {"filter_sha256": "a" * 64},
    )
    return str(
        conn.execute(
            text(
                "SELECT id FROM audit.catalog_export_log "
                "WHERE correlation_id = :correlation_id"
            ),
            {"correlation_id": correlation_id},
        ).scalar_one()
    )


def test_export_audit_function_is_narrow_and_owned_by_auditor(engine) -> None:
    with engine.connect() as conn:
        function = conn.execute(
            text(
                "SELECT proc.prosecdef, role.rolname, proc.proconfig "
                "FROM pg_proc AS proc "
                "JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace "
                "JOIN pg_roles AS role ON role.oid = proc.proowner "
                "WHERE namespace.nspname = 'platform' "
                "AND proc.proname = 'record_catalog_export'"
            )
        ).one()
        privileges = conn.execute(
            text(
                "SELECT "
                "has_function_privilege('labelscan_app', "
                "'platform.record_catalog_export(text, integer, text)', 'EXECUTE'), "
                "has_table_privilege('labelscan_app', "
                "'audit.catalog_export_log', 'SELECT'), "
                "has_table_privilege('labelscan_app', "
                "'audit.catalog_export_log', 'INSERT'), "
                "has_table_privilege('labelscan_app', "
                "'audit.catalog_export_log', 'UPDATE'), "
                "has_table_privilege('labelscan_app', "
                "'audit.catalog_export_log', 'DELETE')"
            )
        ).one()

    assert function.prosecdef is True
    assert function.rolname == "labelscan_auditor"
    assert function.proconfig is not None
    assert "search_path=" in "".join(function.proconfig)
    assert privileges == (True, True, False, False, False)


def test_export_audit_is_written_once_and_hidden_from_another_tenant(engine) -> None:
    organization_id = _organization_id(engine)
    with engine.begin() as conn:
        event_id = _record_as_runtime(conn, organization_id)
        row = conn.execute(
            text(
                "SELECT organization_id::text, actor_id::text, export_format, row_count "
                "FROM audit.catalog_export_log WHERE id = :event_id"
            ),
            {"event_id": event_id},
        ).one()
    assert row == (organization_id, ACTOR_ID, "json", 1)

    with engine.begin() as conn:
        conn.execute(text("SET LOCAL ROLE labelscan_app"))
        set_tenant_context(conn, str(uuid.uuid4()))
        visible = conn.execute(
            text(
                "SELECT count(*) FROM audit.catalog_export_log WHERE id = :event_id"
            ),
            {"event_id": event_id},
        ).scalar_one()
    assert visible == 0


def test_runtime_cannot_forge_or_mutate_export_audit(engine) -> None:
    organization_id = _organization_id(engine)
    with pytest.raises(DBAPIError):
        with engine.begin() as conn:
            conn.execute(text("SET LOCAL ROLE labelscan_app"))
            set_tenant_context(conn, organization_id)
            conn.execute(
                text(
                    "INSERT INTO audit.catalog_export_log ("
                    "organization_id, actor_id, export_format, row_count, "
                    "filter_sha256, correlation_id, trace_id) VALUES ("
                    ":organization_id, :actor_id, 'json', 1, :filter_sha256, "
                    "'forged', 'forged')"
                ),
                {
                    "organization_id": organization_id,
                    "actor_id": ACTOR_ID,
                    "filter_sha256": "b" * 64,
                },
            )

    with engine.begin() as conn:
        event_id = _record_as_runtime(conn, organization_id)
    with pytest.raises(DBAPIError, match="append-only violation"):
        with engine.begin() as conn:
            set_tenant_context(conn, organization_id)
            conn.execute(
                text(
                    "UPDATE audit.catalog_export_log SET row_count = 2 "
                    "WHERE id = :event_id"
                ),
                {"event_id": event_id},
            )
