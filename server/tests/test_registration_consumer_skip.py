"""Integration proofs — registration consumer skips non-extracted outcomes.

Verifies that needs_review and extraction_failed outcomes never produce a batch.
"""

from __future__ import annotations

import json

from sqlalchemy import text

from labelscan.contexts.traceability.adapters.registration_consumer import (
    RegistrationConsumer,
)


def _enqueue_completed(engine, ingestion_id: str, run_id: str, outcome: str) -> str:
    with engine.begin() as c:
        eid = c.execute(
            text(
                "INSERT INTO platform.outbox (event_type, payload, correlation_id, trace_id) "
                "VALUES ('extraction.completed', CAST(:p AS jsonb), 'c', 't') RETURNING id"
            ),
            {
                "p": json.dumps(
                    {"ingestion_id": ingestion_id, "run_id": run_id, "outcome": outcome}
                )
            },
        ).scalar_one()
    return str(eid)


def _batch_count(engine) -> int:
    with engine.connect() as c:
        return c.execute(text("SELECT count(*) FROM traceability.batch")).scalar_one()


class _Msg:
    def __init__(
        self,
        payload,
        correlation_id="c",
        trace_id="t",
        event_type="extraction.completed",
    ):
        self.payload = payload
        self.correlation_id = correlation_id
        self.trace_id = trace_id
        self.event_type = event_type
        self.id = "00000000-0000-0000-0000-000000000000"


def test_needs_review_produces_no_batch(engine):
    before = _batch_count(engine)
    consumer = RegistrationConsumer(engine=engine)
    msg = _Msg(
        {
            "ingestion_id": "00000000-0000-0000-0000-000000000099",
            "run_id": "00000000-0000-0000-0000-000000000100",
            "outcome": "needs_review",
        }
    )
    with engine.begin() as conn:
        consumer(msg, conn)
    assert _batch_count(engine) == before


def test_extraction_failed_produces_no_batch(engine):
    before = _batch_count(engine)
    consumer = RegistrationConsumer(engine=engine)
    msg = _Msg(
        {
            "ingestion_id": "00000000-0000-0000-0000-000000000099",
            "run_id": "00000000-0000-0000-0000-000000000101",
            "outcome": "extraction_failed",
        }
    )
    with engine.begin() as conn:
        consumer(msg, conn)
    assert _batch_count(engine) == before
