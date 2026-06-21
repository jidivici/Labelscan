"""PG-3 proofs — transactional outbox + worker.

Validation requirements:
  - Insert ingestion -> outbox entry exists atomically (same transaction).
  - Worker crash -> message retried (no data loss).
  - No duplicate side-effects after retries (idempotent consumer).
  - Strict decoupling: ingestion only writes an outbox row; the worker dispatches.
"""

from __future__ import annotations

import hashlib
import json

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from labelscan.contexts.ingestion.application.ports import AuditContext
from labelscan.contexts.ingestion.application.submit_ingestion import (
    SubmitIngestionCommand,
)
from labelscan.platform.outbox.worker import OutboxWorker
from tests.conftest import ACTOR_ID


def _cmd(content: bytes, **over) -> SubmitIngestionCommand:
    base = dict(
        image_bytes=content,
        content_type="image/jpeg",
        actor_id=ACTOR_ID,
        correlation_id="corr-ob",
        trace_id="trace-ob",
        principal="device-01",
    )
    base.update(over)
    return SubmitIngestionCommand(**base)


def _enqueue(engine, event_type: str, payload: dict | None = None) -> str:
    with engine.begin() as c:
        eid = c.execute(
            text(
                "INSERT INTO platform.outbox (event_type, payload, correlation_id, trace_id) "
                "VALUES (:et, CAST(:p AS jsonb), 'c', 't') RETURNING id"
            ),
            {"et": event_type, "p": json.dumps(payload or {})},
        ).scalar_one()
    return str(eid)


@pytest.fixture
def sink(engine):
    # transactional side-effect target: rolls back with the worker's txn, so it
    # measures COMMITTED side-effects (unlike an in-memory counter).
    with engine.begin() as c:
        c.execute(
            text(
                "CREATE TABLE IF NOT EXISTS public.test_sink (event_id uuid NOT NULL, consumer text NOT NULL)"
            )
        )
        c.execute(text("TRUNCATE public.test_sink"))
    yield


def _sink_handler(consumer="c1"):
    def handler(msg, conn):
        conn.execute(
            text("INSERT INTO public.test_sink (event_id, consumer) VALUES (:e, :c)"),
            {"e": msg.id, "c": consumer},
        )

    return handler


def _sink_count(engine, event_id: str) -> int:
    with engine.connect() as c:
        return c.execute(
            text("SELECT count(*) FROM public.test_sink WHERE event_id = :e"),
            {"e": event_id},
        ).scalar_one()


def _event_id_for(engine, ingestion_id: str) -> str:
    with engine.connect() as c:
        return str(
            c.execute(
                text(
                    "SELECT id FROM platform.outbox WHERE payload->>'ingestion_id' = :id"
                ),
                {"id": ingestion_id},
            ).scalar_one()
        )


# ----- atomic enqueue ---------------------------------------------------------


def test_ingestion_enqueues_outbox_atomically(submit, engine):
    res = submit(_cmd(b"outbox-atomic-1"))
    with engine.connect() as c:
        rows = (
            c.execute(
                text(
                    "SELECT event_type, payload, published_at FROM platform.outbox "
                    "WHERE payload->>'ingestion_id' = :id"
                ),
                {"id": res.ingestion_id},
            )
            .mappings()
            .all()
        )
    assert len(rows) == 1
    assert rows[0]["event_type"] == "ingestion.raw_stored"
    assert rows[0]["published_at"] is None
    assert rows[0]["payload"]["ingestion_id"] == res.ingestion_id


def test_failed_ingestion_leaves_no_outbox_row(repo, raw_store, engine):
    # poisoned audit -> the whole tx rolls back -> NO ingestion AND NO outbox row.
    content = b"outbox-atomic-fail-2"
    checksum = hashlib.sha256(content).hexdigest()
    raw_store.put(content, checksum=checksum)
    with pytest.raises(DBAPIError):
        repo.persist(
            content_sha256=checksum,
            storage_ref="x",
            barcode_raw=None,
            client_captured_at=None,
            principal="device-01",
            route="POST /v1/ingestions",
            audit=AuditContext("not-a-uuid", "c", "t"),
            action="ingestion.submitted",
        )
    with engine.connect() as c:
        n = c.execute(
            text(
                "SELECT count(*) FROM platform.outbox WHERE payload->>'checksum_sha256' = :ck"
            ),
            {"ck": checksum},
        ).scalar_one()
    assert n == 0


def test_duplicate_submit_enqueues_once(submit, engine):
    content = b"outbox-dup-3"
    first = submit(_cmd(content))
    submit(_cmd(content))  # replay
    with engine.connect() as c:
        n = c.execute(
            text(
                "SELECT count(*) FROM platform.outbox WHERE payload->>'ingestion_id' = :id"
            ),
            {"id": first.ingestion_id},
        ).scalar_one()
    assert n == 1


# ----- worker processing ------------------------------------------------------


def test_worker_processes_real_event_and_marks_published(submit, engine, sink):
    res = submit(_cmd(b"worker-proc-4"))
    eid = _event_id_for(engine, res.ingestion_id)

    worker = OutboxWorker(engine)
    worker.register("ingestion.raw_stored", "extraction", _sink_handler("extraction"))
    worker.run_once()

    assert _sink_count(engine, eid) == 1
    with engine.connect() as c:
        pub = c.execute(
            text("SELECT published_at FROM platform.outbox WHERE id = :e"), {"e": eid}
        ).scalar_one()
        seen = c.execute(
            text(
                "SELECT count(*) FROM platform.processed_event WHERE consumer='extraction' AND event_id=:e"
            ),
            {"e": eid},
        ).scalar_one()
    assert pub is not None
    assert seen == 1


def test_worker_crash_message_retried(engine, sink):
    et = "test.crash.evt"
    eid = _enqueue(engine, et)

    def boom(msg, conn):
        raise RuntimeError("simulated worker crash")

    # R-B01: a handler crash no longer propagates out of run_once and no longer
    # hot-loops — the failure is recorded and the row is parked for backoff.
    crashing = OutboxWorker(engine)
    crashing.register(et, "c1", boom)
    crashing.run_once()

    # the message survived: still pending, not marked processed, no side-effect,
    # and scheduled for a later retry (attempts incremented).
    with engine.connect() as c:
        row = (
            c.execute(
                text(
                    "SELECT status, attempts, next_retry_at, published_at "
                    "FROM platform.outbox WHERE id=:e"
                ),
                {"e": eid},
            )
            .mappings()
            .one()
        )
        seen = c.execute(
            text(
                "SELECT count(*) FROM platform.processed_event WHERE consumer='c1' AND event_id=:e"
            ),
            {"e": eid},
        ).scalar_one()
    assert row["published_at"] is None
    assert row["status"] == "pending"
    assert row["attempts"] == 1
    assert row["next_retry_at"] is not None
    assert seen == 0
    assert _sink_count(engine, eid) == 0

    # once the backoff window elapses, a healthy worker processes it exactly once.
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET next_retry_at = now() - interval '1 second' WHERE id=:e"
            ),
            {"e": eid},
        )
    healthy = OutboxWorker(engine)
    healthy.register(et, "c1", _sink_handler())
    healthy.run_once()
    with engine.connect() as c:
        pub = c.execute(
            text("SELECT published_at FROM platform.outbox WHERE id=:e"), {"e": eid}
        ).scalar_one()
    assert pub is not None
    assert _sink_count(engine, eid) == 1


def test_no_duplicate_side_effects_after_redelivery(engine, sink):
    et = "test.redeliver.evt"
    eid = _enqueue(engine, et)

    worker = OutboxWorker(engine)
    worker.register(et, "c1", _sink_handler())
    worker.run_once()
    assert _sink_count(engine, eid) == 1

    # simulate at-least-once REDELIVERY (relay re-presents the same event).
    with engine.begin() as c:
        c.execute(
            text("UPDATE platform.outbox SET published_at = NULL WHERE id = :e"),
            {"e": eid},
        )
    worker.run_once()

    # idempotent consumer: the side-effect is NOT repeated.
    assert _sink_count(engine, eid) == 1
    with engine.connect() as c:
        pub = c.execute(
            text("SELECT published_at FROM platform.outbox WHERE id=:e"), {"e": eid}
        ).scalar_one()
    assert pub is not None


def test_no_data_loss_when_worker_crashes_mid_batch(engine, sink):
    et = "test.batch.evt"
    eids = [_enqueue(engine, et, {"n": i}) for i in range(3)]

    def handler(msg, conn):
        _sink_handler()(msg, conn)
        if msg.payload.get("n") == 1:
            raise RuntimeError("crash mid-batch")

    # R-B01: the poison event (n==1) no longer aborts the batch. It is parked for
    # retry while its siblings keep flowing — zero data loss AND no head-of-line block.
    worker = OutboxWorker(engine)
    worker.register(et, "c1", handler)
    worker.run_once()

    with engine.connect() as c:
        states = {
            e: c.execute(
                text("SELECT status, published_at FROM platform.outbox WHERE id=:e"),
                {"e": e},
            )
            .mappings()
            .one()
            for e in eids
        }
    assert states[eids[0]]["published_at"] is not None  # processed
    assert states[eids[2]]["published_at"] is not None  # NOT blocked by the poison
    assert states[eids[1]]["published_at"] is None  # parked for retry, not lost
    assert states[eids[1]]["status"] == "pending"
    assert _sink_count(engine, eids[1]) == 0  # crashed side-effect rolled back

    # backoff elapses -> healthy re-run drains the parked event, each effect once.
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET next_retry_at = now() - interval '1 second' WHERE id=:e"
            ),
            {"e": eids[1]},
        )
    healthy = OutboxWorker(engine)
    healthy.register(et, "c1", _sink_handler())
    healthy.run_once()
    with engine.connect() as c:
        remaining = c.execute(
            text(
                "SELECT count(*) FROM platform.outbox WHERE event_type=:et AND published_at IS NULL"
            ),
            {"et": et},
        ).scalar_one()
    assert remaining == 0
    for e in eids:
        assert (
            _sink_count(engine, e) == 1
        )  # exactly-once committed side-effect per event
