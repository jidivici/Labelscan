"""PG-4 proofs (integration) — extraction consumer via the relay worker + DB.

Validation requirements:
  - Duplicate event -> no duplicate side-effects (idempotent consumer).
  - Retry after crash -> exactly one committed result; no duplicate external calls.
  - Invalid extraction -> not marked valid (routed to review; ungrounded value nulled).
  - No path from model output -> DB without the validation gate.
  - Each (re-)extraction is a NEW append-only run; runs are immutable.
  - Failed validation -> mandatory review queue (no silent acceptance).
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.application.submit_ingestion import (
    SubmitIngestionCommand,
)
from labelscan.contexts.ingestion.domain.extraction import RuleSet
from labelscan.platform.outbox.worker import OutboxWorker
from tests._fakes import FakeLlm, FakeOcr, field, good_fields
from tests.conftest import ACTOR_ID

RULES = RuleSet(
    version="test",
    required_fields=frozenset({"scientific_name", "expiry_date", "production_method"}),
)


def _cmd(content: bytes) -> SubmitIngestionCommand:
    return SubmitIngestionCommand(
        image_bytes=content,
        content_type="image/jpeg",
        actor_id=ACTOR_ID,
        correlation_id="corr-ext",
        trace_id="trace-ext",
        principal="device-01",
    )


def _quiesce(engine):
    # mark any pre-existing unpublished events published so this test's worker only
    # ever sees the event it just produced (deterministic call counts).
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET published_at = now() WHERE published_at IS NULL"
            )
        )


def _consumer(engine, raw_store, ocr, llm):
    return ExtractionConsumer(
        engine=engine, raw_store=raw_store, ocr=ocr, llm=llm, rule_set=RULES
    )


def _worker_with(engine, consumer) -> OutboxWorker:
    w = OutboxWorker(engine)
    w.register(consumer.event_type, consumer.consumer_name, consumer)
    return w


def _runs(engine, ingestion_id):
    with engine.connect() as c:
        return (
            c.execute(
                text(
                    "SELECT id, outcome, attempt_no FROM ingestion.extraction_run "
                    "WHERE ingestion_id = :id ORDER BY attempt_no"
                ),
                {"id": ingestion_id},
            )
            .mappings()
            .all()
        )


# ----- happy path -------------------------------------------------------------


def test_extraction_produces_run_fields_and_provenance(submit, engine, raw_store):
    _quiesce(engine)
    res = submit(_cmd(b"extract-happy-1"))
    ocr, llm = FakeOcr(), FakeLlm(good_fields())
    _worker_with(engine, _consumer(engine, raw_store, ocr, llm)).run_once()

    assert ocr.calls == 1 and llm.calls == 1
    runs = _runs(engine, res.ingestion_id)
    assert len(runs) == 1 and runs[0]["outcome"] == "extracted"

    with engine.connect() as c:
        status = c.execute(
            text("SELECT status FROM ingestion.ingestion WHERE id=:id"),
            {"id": res.ingestion_id},
        ).scalar_one()
        sci = (
            c.execute(
                text(
                    "SELECT value, provenance, source_raw_artifact_id, combined_confidence "
                    "FROM ingestion.extracted_field WHERE extraction_run_id=:r AND field_name='scientific_name'"
                ),
                {"r": runs[0]["id"]},
            )
            .mappings()
            .one()
        )
        # OCR + LLM raw outputs are stored immutably
        kinds = c.execute(
            text(
                "SELECT count(*) FROM ingestion.raw_artifact "
                "WHERE ingestion_id=:id AND artifact_kind IN ('ocr_json','llm_output')"
            ),
            {"id": res.ingestion_id},
        ).scalar_one()
    assert status == "extracted"
    assert sci["value"] == "Gadus morhua"
    assert (
        sci["provenance"] is not None and sci["provenance"]["spans"]
    )  # span/page/offset provenance
    assert sci["source_raw_artifact_id"] is not None  # references source raw_artifact
    assert kinds == 2


# ----- idempotency ------------------------------------------------------------


def test_duplicate_event_no_duplicate_side_effects(submit, engine, raw_store):
    _quiesce(engine)
    res = submit(_cmd(b"extract-dup-2"))
    ocr, llm = FakeOcr(), FakeLlm(good_fields())
    worker = _worker_with(engine, _consumer(engine, raw_store, ocr, llm))
    worker.run_once()

    # redeliver the same event (at-least-once): relay re-presents it.
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET published_at = NULL "
                "WHERE payload->>'ingestion_id' = :id"
            ),
            {"id": res.ingestion_id},
        )
    worker.run_once()

    # consumer is idempotent: no second run, no second external call.
    assert len(_runs(engine, res.ingestion_id)) == 1
    assert ocr.calls == 1 and llm.calls == 1


def test_retry_after_crash_exactly_one_run_no_duplicate_calls(
    submit, engine, raw_store
):
    _quiesce(engine)
    res = submit(_cmd(b"extract-crash-3"))
    ocr, llm = FakeOcr(), FakeLlm(good_fields())

    # First attempt: OCR + LLM run (and their raw artifacts commit), then crash before persist commit.
    crashing = _consumer(engine, raw_store, ocr, llm)

    def boom(*a, **k):
        raise RuntimeError("crash before persist commit")

    crashing._persist = boom  # type: ignore[method-assign]
    # R-B01: the crash no longer propagates out of run_once — the worker records
    # the failure and parks the event for backoff instead of crash-looping.
    _worker_with(engine, crashing).run_once()

    assert ocr.calls == 1 and llm.calls == 1
    assert _runs(engine, res.ingestion_id) == []  # nothing committed

    # Once the backoff window elapses, retry with a healthy consumer reusing the
    # SAME fakes -> dedup means no re-call.
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET next_retry_at = now() - interval '1 second' "
                "WHERE payload->>'ingestion_id' = :id"
            ),
            {"id": res.ingestion_id},
        )
    healthy = _consumer(engine, raw_store, ocr, llm)
    _worker_with(engine, healthy).run_once()

    assert ocr.calls == 1 and llm.calls == 1  # external calls NOT repeated
    runs = _runs(engine, res.ingestion_id)
    assert (
        len(runs) == 1 and runs[0]["outcome"] == "extracted"
    )  # exactly one committed result


# ----- validation gate is unavoidable ----------------------------------------


def test_invalid_extraction_not_marked_valid_and_goes_to_review(
    submit, engine, raw_store
):
    _quiesce(engine)
    res = submit(_cmd(b"extract-invalid-4"))
    fabricated = (
        field(
            "scientific_name", "Thunnus thynnus", 0.99, ["Thunnus thynnus"]
        ),  # not in OCR
        field("expiry_date", "2026-06-20", 0.95, ["2026-06-20"]),
        field("production_method", "wild_caught", 0.93, ["Wild caught"]),
    )
    ocr, llm = FakeOcr(), FakeLlm(fabricated)
    _worker_with(engine, _consumer(engine, raw_store, ocr, llm)).run_once()

    runs = _runs(engine, res.ingestion_id)
    assert len(runs) == 1
    assert runs[0]["outcome"] == "needs_review"  # NOT 'extracted'

    with engine.connect() as c:
        status = c.execute(
            text("SELECT status FROM ingestion.ingestion WHERE id=:id"),
            {"id": res.ingestion_id},
        ).scalar_one()
        sci = (
            c.execute(
                text(
                    "SELECT value, provenance FROM ingestion.extracted_field "
                    "WHERE extraction_run_id=:r AND field_name='scientific_name'"
                ),
                {"r": runs[0]["id"]},
            )
            .mappings()
            .one()
        )
        # the fabricated value never reached the DB as a value (gate coerced it to null)
        in_review_queue = c.execute(
            text(
                "SELECT count(*) FROM ingestion.ingestion WHERE id=:id AND status='needs_review'"
            ),
            {"id": res.ingestion_id},
        ).scalar_one()
    assert status == "needs_review"  # mandatory review queue, no silent acceptance
    assert sci["value"] is None
    assert sci["provenance"] is None
    assert in_review_queue == 1


# ----- append-only runs / no overwrite ---------------------------------------


def test_reextraction_is_a_new_append_only_run(submit, engine, raw_store):
    _quiesce(engine)
    res = submit(_cmd(b"extract-rerun-5"))
    ocr, llm = FakeOcr(), FakeLlm(good_fields())
    worker = _worker_with(engine, _consumer(engine, raw_store, ocr, llm))
    worker.run_once()
    first = _runs(engine, res.ingestion_id)
    assert len(first) == 1

    # a genuine re-extraction trigger: a NEW event for the same ingestion.
    with engine.begin() as c:
        c.execute(
            text(
                "INSERT INTO platform.outbox (event_type, payload, correlation_id, trace_id) "
                "SELECT 'ingestion.raw_stored', jsonb_build_object("
                "'ingestion_id', id::text, 'organization_id', organization_id::text), "
                "'corr-ext', 'trace-ext' FROM ingestion.ingestion WHERE id = :id"
            ),
            {"id": res.ingestion_id},
        )
    worker.run_once()

    runs = _runs(engine, res.ingestion_id)
    assert [r["attempt_no"] for r in runs] == [1, 2]  # new run appended, prior retained
    # prior run is immutable
    with pytest.raises(DBAPIError) as ei:
        with engine.begin() as c:
            c.execute(
                text(
                    "UPDATE ingestion.extraction_run SET outcome='extracted' WHERE id=:id"
                ),
                {"id": first[0]["id"]},
            )
    assert "append-only" in str(ei.value).lower()


def test_worker_rejects_an_ingestion_event_with_a_mismatched_tenant(
    submit, engine, raw_store
):
    _quiesce(engine)
    res = submit(_cmd(b"extract-tenant-mismatch"))
    _quiesce(engine)
    with engine.begin() as conn:
        event_id = conn.execute(
            text(
                "INSERT INTO platform.outbox "
                "(event_type, payload, correlation_id, trace_id) "
                "VALUES ('ingestion.raw_stored', jsonb_build_object("
                "'ingestion_id', CAST(:ingestion_id AS text), "
                "'organization_id', CAST(:organization_id AS text)), "
                "'tenant-mismatch', 'tenant-mismatch') RETURNING id::text"
            ),
            {
                "ingestion_id": res.ingestion_id,
                "organization_id": "22222222-2222-2222-2222-222222222222",
            },
        ).scalar_one()

    worker = _worker_with(
        engine,
        _consumer(engine, raw_store, FakeOcr(), FakeLlm(good_fields())),
    )
    assert worker.run_once() == 1
    assert _runs(engine, res.ingestion_id) == []
    with engine.connect() as conn:
        event = (
            conn.execute(
                text(
                    "SELECT attempts, published_at FROM platform.outbox WHERE id = :id"
                ),
                {"id": event_id},
            )
            .mappings()
            .one()
        )
    assert event["attempts"] == 1
    assert event["published_at"] is None


# ----- OCR-quality gate (cost saver) ------------------------------------------


def test_garbage_ocr_skips_llm_and_routes_to_review(submit, engine, raw_store):
    """An illegible image: the OCR-quality gate skips the LLM call entirely and routes
    to review with the distinct `ocr_skipped_garbage` status (no LLM cost incurred)."""
    _quiesce(engine)
    res = submit(_cmd(b"extract-garbage-6"))
    ocr = FakeOcr(full_text="$$ ~~~ ||| .... %%% ## &&", confidence=0.0)
    llm = FakeLlm(good_fields())
    _worker_with(engine, _consumer(engine, raw_store, ocr, llm)).run_once()

    assert ocr.calls == 1
    assert llm.calls == 0  # the LLM call was skipped — the whole point (cost lever)

    runs = _runs(engine, res.ingestion_id)
    assert len(runs) == 1 and runs[0]["outcome"] == "needs_review"

    with engine.connect() as c:
        status = c.execute(
            text("SELECT status FROM ingestion.ingestion WHERE id=:id"),
            {"id": res.ingestion_id},
        ).scalar_one()
        # no llm_output artifact was created (no external LLM call), but OCR was stored
        llm_artifacts = c.execute(
            text(
                "SELECT count(*) FROM ingestion.raw_artifact "
                "WHERE ingestion_id=:id AND artifact_kind='llm_output'"
            ),
            {"id": res.ingestion_id},
        ).scalar_one()
    assert status == "ocr_skipped_garbage"
    assert llm_artifacts == 0
