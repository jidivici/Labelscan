"""R-B01 proofs — Dead-Letter Queue + exponential backoff for the outbox relay.

These are DB integration tests (need a migrated PostgreSQL, like the rest of the
outbox suite). They prove the three guarantees the fix must provide:

  a) a handler that keeps raising sees its next_retry_at pushed further out each
     time (exponential backoff actually delays the next claim);
  b) after MAX_RETRIES the event is parked in the DLQ (status='dead_letter') and
     is never claimed again — the worker stops burning cycles on it;
  c) a dead-lettered poison pill does NOT block fresh events: the relay keeps
     draining everything else (the head-of-line blocking that was R-B01).

A committed `public.test_sink` row is the side-effect probe: it lives and dies
with the worker's transaction, so it measures COMMITTED effects, not in-memory
intent.
"""

from __future__ import annotations

import json
from datetime import datetime

import pytest
from sqlalchemy import text

from labelscan.platform.outbox.worker import OutboxWorker


class PoisonError(RuntimeError):
    """A non-transient handler failure (the LLM can never parse this label)."""


# ----- fixtures / helpers -----------------------------------------------------


@pytest.fixture
def sink(engine):
    with engine.begin() as c:
        c.execute(
            text(
                "CREATE TABLE IF NOT EXISTS public.test_sink "
                "(event_id uuid NOT NULL, consumer text NOT NULL)"
            )
        )
        c.execute(text("TRUNCATE public.test_sink"))
    yield


def _enqueue(engine, event_type: str, payload: dict | None = None) -> str:
    with engine.begin() as c:
        eid = c.execute(
            text(
                "INSERT INTO platform.outbox (event_type, payload, correlation_id, trace_id) "
                "VALUES (:et, CAST(:p AS jsonb), 'corr-dlq', 'trace-dlq') RETURNING id"
            ),
            {"et": event_type, "p": json.dumps(payload or {})},
        ).scalar_one()
    return str(eid)


def _state(engine, eid: str) -> dict:
    """Read the lifecycle columns of one outbox row."""
    with engine.connect() as c:
        return dict(
            c.execute(
                text(
                    "SELECT status, attempts, next_retry_at, last_error, published_at "
                    "FROM platform.outbox WHERE id = :e"
                ),
                {"e": eid},
            )
            .mappings()
            .one()
        )


def _make_due(engine, eid: str) -> None:
    """Simulate the backoff window having elapsed so the row is claimable again."""
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET next_retry_at = now() - interval '1 second' "
                "WHERE id = :e"
            ),
            {"e": eid},
        )


def _sink_count(engine, eid: str) -> int:
    with engine.connect() as c:
        return c.execute(
            text("SELECT count(*) FROM public.test_sink WHERE event_id = :e"),
            {"e": eid},
        ).scalar_one()


def _handler(*, poison_kind: str = "poison", consumer: str = "c1"):
    """Side-effecting handler that raises for poison payloads, succeeds otherwise."""

    def handler(msg, conn):
        if msg.payload.get("kind") == poison_kind:
            raise PoisonError("poison pill: LLM cannot parse this label")
        conn.execute(
            text("INSERT INTO public.test_sink (event_id, consumer) VALUES (:e, :c)"),
            {"e": msg.id, "c": consumer},
        )

    return handler


# ----- a) exponential backoff pushes next_retry_at further each failure -------


def test_backoff_pushes_next_retry_at_further_each_failure(engine, sink):
    et = "test.dlq.backoff"
    eid = _enqueue(engine, et, {"kind": "poison"})

    # max_retries high enough that the 3 observed failures never dead-letter;
    # base 1s keeps the test fast while leaving room for the delay to grow.
    worker = OutboxWorker(engine, max_retries=99, backoff_base_seconds=1.0)
    worker.register(et, "c1", _handler())

    schedules: list[datetime] = []
    for expected_attempts in (1, 2, 3):
        worker.run_once()  # claims, handler raises, failure recorded (no re-raise)
        st = _state(engine, eid)
        assert st["status"] == "pending"  # still retrying, not yet dead
        assert st["attempts"] == expected_attempts
        assert st["next_retry_at"] is not None
        assert st["last_error"] and "PoisonError" in st["last_error"]
        assert st["published_at"] is None
        assert _sink_count(engine, eid) == 0  # poison never commits a side-effect
        schedules.append(st["next_retry_at"])
        _make_due(engine, eid)  # let the worker re-claim it for the next attempt

    # backoff: each scheduled retry is strictly later than the previous one.
    assert schedules[0] < schedules[1] < schedules[2]


# ----- b) DLQ after MAX_RETRIES, never re-claimed -----------------------------


def test_event_dead_lettered_after_max_retries(engine, sink):
    et = "test.dlq.deadletter"
    eid = _enqueue(engine, et, {"kind": "poison"})

    worker = OutboxWorker(engine, max_retries=3, backoff_base_seconds=0.5)
    worker.register(et, "c1", _handler())

    # Drive attempts up to the limit, releasing the backoff gate between tries.
    for _ in range(3):
        worker.run_once()
        if _state(engine, eid)["status"] == "dead_letter":
            break
        _make_due(engine, eid)

    st = _state(engine, eid)
    assert st["status"] == "dead_letter"
    assert st["attempts"] == 3
    assert st["next_retry_at"] is None  # parked: no further retry scheduled
    assert st["last_error"] and "PoisonError" in st["last_error"]
    assert st["published_at"] is None  # dead != published

    # A dead-lettered row is excluded from the claim even once "due": the worker
    # stops picking it up entirely, so it can no longer burn cycles.
    _make_due(engine, eid)
    assert worker.run_once() == 0
    assert _state(engine, eid)["status"] == "dead_letter"
    assert _state(engine, eid)["attempts"] == 3  # not bumped again
    assert _sink_count(engine, eid) == 0


# ----- c) a dead-lettered poison pill does not block fresh events -------------


def test_dead_letter_does_not_block_new_events(engine, sink):
    et = "test.dlq.isolation"
    # The poison is enqueued FIRST, so it is the oldest row of its type — under the
    # old worker (ORDER BY created_at + crash-loop) it would block everything behind it.
    poison = _enqueue(engine, et, {"kind": "poison"})

    worker = OutboxWorker(engine, max_retries=3, backoff_base_seconds=0.5)
    worker.register(et, "c1", _handler())

    for _ in range(3):
        worker.run_once()
        if _state(engine, poison)["status"] == "dead_letter":
            break
        _make_due(engine, poison)
    assert _state(engine, poison)["status"] == "dead_letter"

    # Fresh, healthy events arrive AFTER the poison is parked.
    healthy = [_enqueue(engine, et, {"kind": "ok", "n": i}) for i in range(2)]

    processed = worker.run_once()

    # Both healthy events are processed in a single pass; the poison is untouched.
    assert processed == 2
    for eid in healthy:
        assert _sink_count(engine, eid) == 1
        assert _state(engine, eid)["status"] == "published"
    poison_state = _state(engine, poison)
    assert poison_state["status"] == "dead_letter"
    assert poison_state["attempts"] == 3  # never re-claimed
