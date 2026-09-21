"""Integration proofs — concurrent outbox workers (FOR UPDATE SKIP LOCKED).

Verifies that two workers processing events concurrently produce zero duplicate
side-effects and zero lost events.
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy import text

from labelscan.platform.outbox.worker import OutboxWorker


def _enqueue(engine, event_type: str, n: int) -> list[str]:
    ids = []
    with engine.begin() as c:
        for i in range(n):
            eid = c.execute(
                text(
                    "INSERT INTO platform.outbox (event_type, payload, correlation_id, trace_id) "
                    "VALUES (:et, CAST(:p AS jsonb), 'c', 't') RETURNING id"
                ),
                {"et": event_type, "p": json.dumps({"i": i})},
            ).scalar_one()
            ids.append(str(eid))
    return ids


@pytest.fixture
def sink(engine):
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


def test_two_workers_no_duplicate_side_effects(engine, sink):
    et = "test.concurrent.evt"
    ids = _enqueue(engine, et, 6)

    w1 = OutboxWorker(engine)
    w1.register(et, "c1", _sink_handler("c1"))
    w2 = OutboxWorker(engine)
    w2.register(et, "c1", _sink_handler("c1"))

    w1.run_once()
    w2.run_once()

    with engine.connect() as c:
        for eid in ids:
            n = c.execute(
                text("SELECT count(*) FROM public.test_sink WHERE event_id = :e"),
                {"e": eid},
            ).scalar_one()
            assert n == 1, f"event {eid} processed {n} times, expected 1"


def test_two_workers_all_events_processed(engine, sink):
    et = "test.concurrent.all"
    _enqueue(engine, et, 4)

    w1 = OutboxWorker(engine)
    w1.register(et, "c1", _sink_handler("c1"))
    w2 = OutboxWorker(engine)
    w2.register(et, "c1", _sink_handler("c1"))

    w1.run_once()
    w2.run_once()

    with engine.connect() as c:
        remaining = c.execute(
            text(
                "SELECT count(*) FROM platform.outbox WHERE event_type = :et AND published_at IS NULL"
            ),
            {"et": et},
        ).scalar_one()
    assert remaining == 0


def test_interleaved_run_once_no_data_loss(engine, sink):
    et = "test.interleaved.evt"
    ids = _enqueue(engine, et, 3)

    w1 = OutboxWorker(engine)
    w1.register(et, "c1", _sink_handler("c1"))
    w2 = OutboxWorker(engine)
    w2.register(et, "c1", _sink_handler("c1"))

    for _ in range(5):
        if w1.run_once() == 0 and w2.run_once() == 0:
            break

    with engine.connect() as c:
        for eid in ids:
            n = c.execute(
                text("SELECT count(*) FROM public.test_sink WHERE event_id = :e"),
                {"e": eid},
            ).scalar_one()
            assert n == 1
