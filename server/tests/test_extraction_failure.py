"""PG-5 proof — provider failures produce a FAILED run after the retry limit,
with no infinite retry loop."""

from __future__ import annotations

from sqlalchemy import text

from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.application.submit_ingestion import (
    SubmitIngestionCommand,
)
from labelscan.contexts.ingestion.domain.extraction import RuleSet
from labelscan.platform.outbox.worker import OutboxWorker
from tests._fakes import FakeOcr, RaisingLlm
from tests.conftest import ACTOR_ID

RULES = RuleSet(version="test", required_fields=frozenset({"scientific_name"}))


def _quiesce(engine):
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET published_at = now() WHERE published_at IS NULL"
            )
        )


def test_provider_failure_produces_failed_run_after_retry_limit(
    submit, engine, raw_store
):
    _quiesce(engine)
    res = submit(
        SubmitIngestionCommand(
            image_bytes=b"provider-fail-1",
            content_type="image/jpeg",
            actor_id=ACTOR_ID,
            correlation_id="corr-f",
            trace_id="trace-f",
            principal="device-01",
        )
    )
    ocr, llm = FakeOcr(), RaisingLlm()
    consumer = ExtractionConsumer(
        engine=engine,
        raw_store=raw_store,
        ocr=ocr,
        llm=llm,
        rule_set=RULES,
        max_provider_attempts=3,
    )
    worker = OutboxWorker(engine)
    worker.register(consumer.event_type, consumer.consumer_name, consumer)

    # does NOT raise (no crash loop) — the consumer records a FAILED run and consumes the event.
    worker.run_once()

    assert llm.calls == 3  # retried up to the limit, then gave up

    with engine.connect() as c:
        run = (
            c.execute(
                text(
                    "SELECT outcome FROM ingestion.extraction_run WHERE ingestion_id = :id"
                ),
                {"id": res.ingestion_id},
            )
            .mappings()
            .all()
        )
        status = c.execute(
            text("SELECT status FROM ingestion.ingestion WHERE id = :id"),
            {"id": res.ingestion_id},
        ).scalar_one()
        raw_stored_unpublished = c.execute(
            text(
                "SELECT count(*) FROM platform.outbox WHERE event_type = 'ingestion.raw_stored' "
                "AND payload->>'ingestion_id' = :id AND published_at IS NULL"
            ),
            {"id": res.ingestion_id},
        ).scalar_one()

    assert (
        len(run) == 1 and run[0]["outcome"] == "extraction_failed"
    )  # FAILED run recorded
    assert status == "extraction_failed"
    assert (
        raw_stored_unpublished == 0
    )  # the trigger event was consumed — no infinite retry loop

    # a second run does nothing (already processed) — definitively no loop.
    assert worker.run_once() == 0
