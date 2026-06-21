"""PROOF 3 — a transaction rollback removes BOTH the business row and its audit
row. Because the audit entry is written in the same transaction by the trigger,
there is no state in which data survives without audit (or audit without data).
"""

from __future__ import annotations

import uuid

from sqlalchemy import text

from labelscan.platform.db.audit_context import set_audit_context
from tests.conftest import ACTOR_ID, insert_raw_artifact


class _ForceRollback(Exception):
    pass


def test_rollback_removes_data_and_audit_together(conn):
    ingestion_id = str(uuid.uuid4())
    captured_rid: str | None = None

    try:
        with conn.begin():  # rolls back if the block raises
            set_audit_context(
                conn,
                actor_id=ACTOR_ID,
                action="ingest.raw_stored",
                correlation_id="corr-rb",
                trace_id="trace-rb",
            )
            captured_rid = insert_raw_artifact(conn, ingestion_id=ingestion_id)

            # Within the tx, both rows exist:
            assert (
                conn.execute(
                    text("SELECT count(*) FROM ingestion.raw_artifact WHERE id = :id"),
                    {"id": captured_rid},
                ).scalar_one()
                == 1
            )
            assert (
                conn.execute(
                    text("SELECT count(*) FROM audit.audit_log WHERE subject_id = :id"),
                    {"id": captured_rid},
                ).scalar_one()
                == 1
            )

            raise _ForceRollback()
    except _ForceRollback:
        pass

    # After rollback, in a fresh transaction, NEITHER row survives.
    with conn.begin():
        data_rows = conn.execute(
            text(
                "SELECT count(*) FROM ingestion.raw_artifact WHERE ingestion_id = :ing"
            ),
            {"ing": ingestion_id},
        ).scalar_one()
        audit_rows = conn.execute(
            text("SELECT count(*) FROM audit.audit_log WHERE subject_id = :id"),
            {"id": captured_rid},
        ).scalar_one()

    assert data_rows == 0, "business row must not survive rollback"
    assert audit_rows == 0, "audit row must not survive rollback (atomic with the data)"
