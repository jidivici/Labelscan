"""PROOF 2 — every INSERT into an audited table produces exactly one audit row
in the SAME transaction, and audit cannot be bypassed or forged.

Covers the STOP rule: "If audit can be bypassed -> STOP".
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from labelscan.platform.db.audit_context import audited_transaction
from tests.conftest import ACTOR_ID, insert_raw_artifact


def test_insert_creates_matching_audit_row_in_same_tx(conn):
    # Everything below happens INSIDE one transaction; the assertion runs before commit.
    with audited_transaction(
        conn,
        actor_id=ACTOR_ID,
        action="ingest.raw_stored",
        correlation_id="corr-A",
        trace_id="trace-A",
    ):
        rid = insert_raw_artifact(conn)
        rows = conn.execute(
            text(
                "SELECT actor_id::text, action, correlation_id, trace_id, "
                "subject_schema, subject_table "
                "FROM audit.audit_log WHERE subject_id = :id"
            ),
            {"id": rid},
        ).all()

        assert len(rows) == 1, (
            "exactly one audit row per insert, visible in the same tx"
        )
        actor, action, corr, trace, schema, table = rows[0]
        assert actor == ACTOR_ID
        assert action == "ingest.raw_stored"
        assert corr == "corr-A"
        assert trace == "trace-A"
        assert (schema, table) == ("ingestion", "raw_artifact")


def test_insert_without_audit_context_is_rejected(conn):
    # No set_audit_context -> the trigger RAISEs -> the insert cannot succeed.
    with pytest.raises(DBAPIError) as ei:
        with conn.begin():
            insert_raw_artifact(conn, ingestion_id=str(uuid.uuid4()))
    assert "audit context missing" in str(ei.value).lower()


def test_app_role_cannot_insert_audit_directly(conn):
    # The app principal has no INSERT on audit_log; it can only ever be written by
    # the SECURITY DEFINER trigger. So a forged/standalone audit row is impossible.
    with pytest.raises(DBAPIError) as ei:
        with conn.begin():
            conn.execute(text("SET ROLE labelscan_app"))
            conn.execute(
                text(
                    "INSERT INTO audit.audit_log "
                    "(actor_id, action, subject_schema, subject_table, subject_id, correlation_id, trace_id) "
                    "VALUES (:a, 'forged', 'ingestion', 'raw_artifact', gen_random_uuid(), 'x', 'y')"
                ),
                {"a": ACTOR_ID},
            )
    assert "permission denied" in str(ei.value).lower()


def test_audit_count_equals_insert_count(conn):
    n = 5
    ids: list[str] = []
    with audited_transaction(
        conn,
        actor_id=ACTOR_ID,
        action="ingest.raw_stored",
        correlation_id="corr-N",
        trace_id="trace-N",
    ):
        for _ in range(n):
            ids.append(insert_raw_artifact(conn))
        total = conn.execute(
            text("SELECT count(*) FROM audit.audit_log WHERE subject_id = ANY(:ids)"),
            {"ids": ids},
        ).scalar_one()
    assert total == n, "one audit row per business insert — no gaps, no duplicates"
