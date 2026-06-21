"""PG-2 precondition proofs — the SECURITY DEFINER audit function is hardened and
the audit context is strictly validated (cannot record a spoofed/garbage actor).
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from labelscan.platform.db.audit_context import set_audit_context
from tests.conftest import insert_raw_artifact

_PROC = text(
    "SELECT p.prosecdef, r.rolname AS owner, r.rolsuper, p.proconfig "
    "FROM pg_proc p "
    "JOIN pg_roles r ON r.oid = p.proowner "
    "JOIN pg_namespace n ON n.oid = p.pronamespace "
    "WHERE n.nspname = 'platform' AND p.proname = 'audit_on_insert'"
)


def test_audit_function_is_security_definer_owned_by_minimal_role(engine):
    with engine.connect() as c:
        secdef, owner, owner_is_super, proconfig = c.execute(_PROC).one()

    assert secdef is True, "audit_on_insert must be SECURITY DEFINER"
    assert owner == "labelscan_auditor", (
        "must run as the dedicated minimal role, not the superuser"
    )
    assert owner_is_super is False, (
        "the definer role must NOT be a superuser (least privilege)"
    )
    # fixed, empty search_path closes search-path-capture on the definer function
    assert proconfig is not None and any(
        s.startswith("search_path=") for s in proconfig
    )
    assert "search_path=" in "".join(proconfig)


def test_minimal_role_has_only_audit_insert(engine):
    # labelscan_auditor may INSERT into audit_log and nothing else meaningful.
    with engine.connect() as c:
        can_insert = c.execute(
            text(
                "SELECT has_table_privilege('labelscan_auditor', 'audit.audit_log', 'INSERT')"
            )
        ).scalar_one()
        can_select_ingestion = c.execute(
            text(
                "SELECT has_table_privilege('labelscan_auditor', 'ingestion.raw_artifact', 'SELECT')"
            )
        ).scalar_one()
    assert can_insert is True
    assert can_select_ingestion is False, (
        "the auditor role has no business reading source tables"
    )


def test_strict_validation_rejects_non_uuid_actor(conn):
    # A malformed actor_id cannot be recorded — anti-spoof / anti-garbage.
    with pytest.raises(DBAPIError) as ei:
        with conn.begin():
            set_audit_context(
                conn,
                actor_id="not-a-uuid",
                action="ingest.raw_stored",
                correlation_id="corr",
                trace_id="trace",
            )
            insert_raw_artifact(conn)
    assert "actor_id is not a uuid" in str(ei.value).lower()
