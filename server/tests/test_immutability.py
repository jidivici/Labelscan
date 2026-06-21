"""PROOF 1 — historical records cannot be mutated at the DB level.

Covers the STOP rule: "If mutation is possible -> STOP". UPDATE/DELETE/TRUNCATE
must fail for EVERY principal — the owner (via the deny_mutation trigger) and the
app role (via both the trigger and the withheld privilege).
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from labelscan.platform.db.audit_context import audited_transaction
from tests.conftest import ACTOR_ID, insert_raw_artifact


def _seed(conn) -> str:
    with audited_transaction(
        conn,
        actor_id=ACTOR_ID,
        action="ingest.raw_stored",
        correlation_id="corr-imm",
        trace_id="trace-imm",
    ):
        return insert_raw_artifact(conn)


def test_update_blocked_for_owner(conn):
    rid = _seed(conn)
    with pytest.raises(DBAPIError) as ei:
        with conn.begin():
            conn.execute(
                text(
                    "UPDATE ingestion.raw_artifact SET storage_ref = 'tampered' WHERE id = :id"
                ),
                {"id": rid},
            )
    assert "append-only" in str(ei.value).lower()


def test_delete_blocked_for_owner(conn):
    rid = _seed(conn)
    with pytest.raises(DBAPIError) as ei:
        with conn.begin():
            conn.execute(
                text("DELETE FROM ingestion.raw_artifact WHERE id = :id"), {"id": rid}
            )
    assert "append-only" in str(ei.value).lower()


def test_truncate_blocked_for_owner(conn):
    _seed(conn)
    with pytest.raises(DBAPIError) as ei:
        with conn.begin():
            conn.execute(text("TRUNCATE ingestion.raw_artifact"))
    assert "append-only" in str(ei.value).lower()


def test_update_blocked_for_app_role(conn):
    rid = _seed(conn)
    with pytest.raises(DBAPIError) as ei:
        with conn.begin():
            conn.execute(text("SET ROLE labelscan_app"))
            conn.execute(
                text(
                    "UPDATE ingestion.raw_artifact SET storage_ref = 'tampered' WHERE id = :id"
                ),
                {"id": rid},
            )
    msg = str(ei.value).lower()
    # Either the privilege check (no UPDATE granted) or the trigger fires first.
    assert "permission denied" in msg or "append-only" in msg


def test_delete_blocked_for_app_role(conn):
    rid = _seed(conn)
    with pytest.raises(DBAPIError) as ei:
        with conn.begin():
            conn.execute(text("SET ROLE labelscan_app"))
            conn.execute(
                text("DELETE FROM ingestion.raw_artifact WHERE id = :id"), {"id": rid}
            )
    msg = str(ei.value).lower()
    assert "permission denied" in msg or "append-only" in msg


def test_audit_log_is_immutable(conn):
    # First create an audit row by inserting a business row.
    rid = _seed(conn)
    with pytest.raises(DBAPIError) as ei:
        with conn.begin():
            conn.execute(
                text(
                    "UPDATE audit.audit_log SET action = 'tampered' WHERE subject_id = :id"
                ),
                {"id": rid},
            )
    assert "append-only" in str(ei.value).lower()

    with pytest.raises(DBAPIError) as ei:
        with conn.begin():
            conn.execute(
                text("DELETE FROM audit.audit_log WHERE subject_id = :id"), {"id": rid}
            )
    assert "append-only" in str(ei.value).lower()
