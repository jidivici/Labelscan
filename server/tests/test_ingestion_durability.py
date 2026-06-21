"""PG-2 proofs — ingestion durability & idempotency.

Validation requirements:
  - Return 202 ONLY after the durable write.
  - Duplicate ingestion -> no duplicate record.
  - Crash before ack -> data still present (no data loss).
  - No path allows a write without audit context.
"""

from __future__ import annotations

import hashlib

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from labelscan.contexts.ingestion.application.ports import AuditContext
from labelscan.contexts.ingestion.application.submit_ingestion import (
    SubmitIngestion,
    SubmitIngestionCommand,
)
from tests.conftest import ACTOR_ID


def _cmd(content: bytes, **over) -> SubmitIngestionCommand:
    base = dict(
        image_bytes=content,
        content_type="image/jpeg",
        actor_id=ACTOR_ID,
        correlation_id="corr-ing",
        trace_id="trace-ing",
        principal="device-01",
    )
    base.update(over)
    return SubmitIngestionCommand(**base)


def _sha(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def test_202_returned_only_after_durable_write(submit, raw_store, engine):
    content = b"\xff\xd8\xff-jpeg-bytes-unique-1"
    res = submit(_cmd(content))

    assert res.http_status == 202
    assert res.replayed is False
    assert res.status == "raw_stored"

    checksum = _sha(content)
    # raw bytes are durable in the object store
    assert raw_store.exists(checksum=checksum)
    # and the DB rows are committed (a 202 implies the transaction committed)
    with engine.connect() as c:
        row = c.execute(
            text(
                "SELECT status, checksum_sha256 FROM ingestion.ingestion WHERE id = :id"
            ),
            {"id": res.ingestion_id},
        ).one()
        assert row.status == "raw_stored"
        assert row.checksum_sha256 == checksum
        raw_cnt = c.execute(
            text(
                "SELECT count(*) FROM ingestion.raw_artifact WHERE ingestion_id = :id"
            ),
            {"id": res.ingestion_id},
        ).scalar_one()
        assert raw_cnt == 1


def test_duplicate_ingestion_no_duplicate_record(submit, engine):
    content = b"dup-content-unique-2"
    first = submit(_cmd(content))
    second = submit(_cmd(content))

    assert second.replayed is True
    assert second.ingestion_id == first.ingestion_id

    checksum = _sha(content)
    with engine.connect() as c:
        ing_cnt = c.execute(
            text(
                "SELECT count(*) FROM ingestion.ingestion WHERE checksum_sha256 = :ck"
            ),
            {"ck": checksum},
        ).scalar_one()
        raw_cnt = c.execute(
            text(
                "SELECT count(*) FROM ingestion.raw_artifact WHERE checksum_sha256 = :ck"
            ),
            {"ck": checksum},
        ).scalar_one()
        ingestion_audit = c.execute(
            text("SELECT count(*) FROM audit.audit_log WHERE subject_id = :id"),
            {"id": first.ingestion_id},
        ).scalar_one()

    assert ing_cnt == 1, "exactly one ingestion record despite two submits"
    assert raw_cnt == 1, "exactly one raw_artifact despite two submits"
    assert ingestion_audit == 1, (
        "the replay produced no second audit row for the ingestion"
    )


def test_crash_before_ack_leaves_data_present(raw_store, repo, engine):
    # Perform the durable write, then "crash" before the 202 is returned to the client.
    content = b"crash-before-ack-unique-3"
    checksum = _sha(content)
    storage_ref = raw_store.put(content, checksum=checksum)
    res = repo.persist(
        content_sha256=checksum,
        storage_ref=storage_ref,
        barcode_raw=None,
        client_captured_at=None,
        principal="device-01",
        route="POST /v1/ingestions",
        audit=AuditContext(ACTOR_ID, "corr-c", "trace-c"),
        action="ingestion.submitted",
    )
    # <-- the process dies here; the client never receives the 202.

    # The data is still present (the write committed before any ack):
    assert raw_store.exists(checksum=checksum)
    with engine.connect() as c:
        assert (
            c.execute(
                text("SELECT count(*) FROM ingestion.ingestion WHERE id = :id"),
                {"id": res.ingestion_id},
            ).scalar_one()
            == 1
        )

    # And the client's retry is idempotent — no duplicate record.
    retry = SubmitIngestion(raw_store, repo)(_cmd(content))
    assert retry.replayed is True
    assert retry.ingestion_id == res.ingestion_id


def test_no_data_loss_when_db_fails_after_durable_put(raw_store, repo, engine):
    # Bytes are durably PUT, then the DB transaction fails (poisoned audit context).
    content = b"db-fail-after-put-unique-4"
    checksum = _sha(content)
    raw_store.put(content, checksum=checksum)  # durable

    with pytest.raises(DBAPIError):
        repo.persist(
            content_sha256=checksum,
            storage_ref=f"{checksum[:2]}/{checksum}",
            barcode_raw=None,
            client_captured_at=None,
            principal="device-01",
            route="POST /v1/ingestions",
            audit=AuditContext(
                "not-a-uuid", "corr", "trace"
            ),  # rejected by the hardened trigger
            action="ingestion.submitted",
        )

    # The bytes were NOT lost, and no partial DB record exists.
    assert raw_store.exists(checksum=checksum)
    with engine.connect() as c:
        assert (
            c.execute(
                text(
                    "SELECT count(*) FROM ingestion.ingestion WHERE checksum_sha256 = :ck"
                ),
                {"ck": checksum},
            ).scalar_one()
            == 0
        )

    # A correct retry completes cleanly (idempotency was rolled back with the failed tx).
    ok = SubmitIngestion(raw_store, repo)(_cmd(content))
    assert ok.http_status == 202
    assert ok.replayed is False


def test_no_write_without_audit_context(engine):
    # There is no path to insert an ingestion without audit context — the trigger rejects it.
    with pytest.raises(DBAPIError) as ei:
        with engine.begin() as c:
            c.execute(
                text(
                    "INSERT INTO ingestion.ingestion "
                    "(status, image_ref, checksum_sha256, correlation_id, trace_id) "
                    "VALUES ('raw_stored', 'ref', 'ck', 'x', 'y')"
                )
            )
    assert "audit context missing" in str(ei.value).lower()
