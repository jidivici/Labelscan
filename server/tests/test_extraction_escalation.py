"""Work Item A (two-tier escalation) proofs — Haiku primary -> escalation tier.

The escalation tier is a SECOND LlmExtractor behind the SAME port, called at most
once per ingestion and only when the gated PRIMARY would force needs_review on a
RULE-SET-REQUIRED FREE-TEXT field that GS1 cannot supply. The gate is never relaxed:
the escalated output is re-run through evaluate() and reconciled with GS1 (GS1 wins).
A lot/DLC barcode<->print conflict is a real anomaly and must NOT be escalated.

Needs PostgreSQL (the engine fixture skips otherwise).
"""

from __future__ import annotations

from sqlalchemy import text

from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.application.submit_ingestion import (
    SubmitIngestionCommand,
)
from labelscan.contexts.ingestion.domain.extraction import RuleSet
from labelscan.platform.outbox.worker import OutboxWorker
from tests._fakes import FakeLlm, FakeOcr, field
from tests.conftest import ACTOR_ID, capture_logger

RULES = RuleSet(
    version="test",
    required_fields=frozenset({"scientific_name", "expiry_date", "production_method"}),
)

_LOG = "labelscan.ingestion.extraction"


def _quiesce(engine):
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET published_at = now() WHERE published_at IS NULL"
            )
        )


def _cmd(content: bytes, barcode_raw: str | None = None) -> SubmitIngestionCommand:
    return SubmitIngestionCommand(
        image_bytes=content,
        content_type="image/jpeg",
        actor_id=ACTOR_ID,
        correlation_id="corr-esc",
        trace_id="trace-esc",
        principal="device-01",
        barcode_raw=barcode_raw,
    )


def _run(
    engine,
    raw_store,
    ocr,
    primary,
    *,
    escalation_llm=None,
    enabled=False,
    rules=RULES,
):
    consumer = ExtractionConsumer(
        engine=engine,
        raw_store=raw_store,
        ocr=ocr,
        llm=primary,
        rule_set=rules,
        escalation_llm=escalation_llm,
        escalation_enabled=enabled,
    )
    w = OutboxWorker(engine)
    w.register(consumer.event_type, consumer.consumer_name, consumer)
    w.run_once()


def _run_row(engine, ingestion_id):
    with engine.connect() as c:
        return (
            c.execute(
                text(
                    "SELECT outcome, llm_model, escalation_model "
                    "FROM ingestion.extraction_run WHERE ingestion_id = :i "
                    "ORDER BY attempt_no DESC LIMIT 1"
                ),
                {"i": ingestion_id},
            )
            .mappings()
            .one()
        )


def _status(engine, ingestion_id):
    with engine.connect() as c:
        return c.execute(
            text("SELECT status FROM ingestion.ingestion WHERE id = :i"),
            {"i": ingestion_id},
        ).scalar_one()


def _field(engine, ingestion_id, name):
    with engine.connect() as c:
        return (
            c.execute(
                text(
                    "SELECT ef.value, ef.source, ef.combined_confidence "
                    "FROM ingestion.extracted_field ef "
                    "JOIN ingestion.extraction_run er ON er.id = ef.extraction_run_id "
                    "WHERE er.ingestion_id = :i AND ef.field_name = :n"
                ),
                {"i": ingestion_id, "n": name},
            )
            .mappings()
            .one()
        )


def _llm_artifact_count(engine, ingestion_id, model=None):
    sql = (
        "SELECT count(*) FROM ingestion.raw_artifact "
        "WHERE ingestion_id = :i AND artifact_kind = 'llm_output'"
    )
    params = {"i": ingestion_id}
    if model is not None:
        sql += " AND model = :m"
        params["m"] = model
    with engine.connect() as c:
        return c.execute(text(sql), params).scalar_one()


# The primary returns the required free-text scientific_name GROUNDED but LOW
# confidence: combined = min(0.30, ocr 0.95) = 0.30 < review_below(0.70) ->
# low_confidence_required. The VALUE is present in OCR_TEXT ("Gadus morhua").
def _primary_low_sci(*, with_expiry=True):
    fs = [
        field("scientific_name", "Gadus morhua", 0.30, ["Gadus morhua"]),
        field("production_method", "wild_caught", 0.93, ["Wild caught"]),
    ]
    if with_expiry:
        fs.append(field("expiry_date", "2026-06-20", 0.95, ["2026-06-20"]))
    return tuple(fs)


def _all_required_strong():
    # every required field grounded high: combined = min(0.9x, 0.95) >= 0.70.
    return (
        field("scientific_name", "Gadus morhua", 0.96, ["Gadus morhua"]),
        field("production_method", "wild_caught", 0.95, ["Wild caught"]),
        field("expiry_date", "2026-06-20", 0.96, ["2026-06-20"]),
    )


# ----- flag OFF: escalation injected but never called --------------------------


def test_flag_off_no_escalation_still_needs_review(submit, engine, raw_store):
    _quiesce(engine)
    res = submit(_cmd(b"esc-off-1"))
    primary = FakeLlm(_primary_low_sci())
    escalation = FakeLlm(_all_required_strong(), model="fake-opus")
    _run(
        engine, raw_store, FakeOcr(), primary, escalation_llm=escalation, enabled=False
    )

    assert primary.calls == 1
    assert escalation.calls == 0  # flag off => never called
    row = _run_row(engine, res.ingestion_id)
    assert row["outcome"] == "needs_review"
    assert row["escalation_model"] is None  # nothing escalated
    assert _status(engine, res.ingestion_id) == "needs_review"


# ----- flag ON: a recoverable free-text field is grounded by the second tier ----


def test_flag_on_recovers_free_text_field_to_extracted(
    submit, engine, raw_store, caplog
):
    _quiesce(engine)
    res = submit(_cmd(b"esc-on-2"))
    primary = FakeLlm(_primary_low_sci())
    escalation = FakeLlm(_all_required_strong(), model="fake-opus")
    with capture_logger(caplog, _LOG):
        _run(
            engine, raw_store, FakeOcr(), primary,
            escalation_llm=escalation, enabled=True,
        )

    assert primary.calls == 1
    assert escalation.calls == 1  # escalated EXACTLY once
    row = _run_row(engine, res.ingestion_id)
    assert row["outcome"] == "extracted"  # would-be needs_review, now grounded
    assert row["escalation_model"] == "fake-opus"
    assert row["llm_model"] == "fake-llm"  # primary model provenance unchanged
    sci = _field(engine, res.ingestion_id, "scientific_name")
    assert sci["value"] == "Gadus morhua"
    assert sci["source"] == "llm"  # escalated values stay source='llm'
    assert float(sci["combined_confidence"]) >= 0.70  # re-gated above review threshold
    assert _status(engine, res.ingestion_id) == "extracted"
    msgs = [r.getMessage() for r in caplog.records]
    assert "llm_escalation_total" in msgs  # attempt metric
    assert "llm_escalation_resolved_total" in msgs  # resolved metric


# ----- lot/DLC barcode<->print conflict: a real anomaly, NEVER escalated --------


def test_lot_dlc_conflict_does_not_escalate(submit, engine, raw_store):
    _quiesce(engine)
    # barcode DLC 2025-12-31 vs the LLM's 2026-06-20 -> conflict on a GS1-owned field.
    res = submit(_cmd(b"esc-conflict-3", barcode_raw="(10)2548541(17)251231"))
    primary = FakeLlm(_all_required_strong())  # no free-text gap in the gated primary
    escalation = FakeLlm(_all_required_strong(), model="fake-opus")
    _run(engine, raw_store, FakeOcr(), primary, escalation_llm=escalation, enabled=True)

    assert escalation.calls == 0  # GS1-owned conflict is not escalation-recoverable
    row = _run_row(engine, res.ingestion_id)
    assert row["outcome"] == "needs_review"
    assert row["escalation_model"] is None
    assert _status(engine, res.ingestion_id) == "needs_review"


# ----- GS1 precedence is preserved even when escalation runs --------------------


def test_gs1_field_not_overridden_by_escalation(submit, engine, raw_store):
    _quiesce(engine)
    # barcode supplies expiry (17)251231; the primary omits expiry and is low on sci.
    res = submit(_cmd(b"esc-gs1-4", barcode_raw="(17)251231"))
    primary = FakeLlm(_primary_low_sci(with_expiry=False))
    escalation = FakeLlm(
        (
            field("scientific_name", "Gadus morhua", 0.96, ["Gadus morhua"]),
            field("production_method", "wild_caught", 0.95, ["Wild caught"]),
        ),
        model="fake-opus",
    )
    _run(engine, raw_store, FakeOcr(), primary, escalation_llm=escalation, enabled=True)

    assert escalation.calls == 1
    # GS1 still wins: expiry keeps source='gs1' and confidence 1.0 here —
    # escalation never touched it.
    exp = _field(engine, res.ingestion_id, "expiry_date")
    assert exp["value"] == "2025-12-31"
    assert exp["source"] == "gs1"
    assert float(exp["combined_confidence"]) == 1.0
    sci = _field(engine, res.ingestion_id, "scientific_name")
    assert sci["source"] == "llm" and sci["value"] == "Gadus morhua"
    row = _run_row(engine, res.ingestion_id)
    assert row["escalation_model"] == "fake-opus"
    assert _status(engine, res.ingestion_id) == "extracted"


# ----- dedup: the same model is never called twice for one ingestion ------------


def test_same_model_never_called_twice_for_one_ingestion(submit, engine, raw_store):
    _quiesce(engine)
    res = submit(_cmd(b"esc-samemodel-5"))
    primary = FakeLlm(_primary_low_sci())  # model 'fake-llm'
    escalation = FakeLlm(_all_required_strong())  # ALSO model 'fake-llm' (misconfig)
    _run(engine, raw_store, FakeOcr(), primary, escalation_llm=escalation, enabled=True)

    assert primary.calls == 1
    # the escalation existence query (ingestion, kind, model) finds the primary's
    # artifact and short-circuits the call -> the same model is never called twice.
    assert escalation.calls == 0
    assert _llm_artifact_count(engine, res.ingestion_id) == 1
    assert _llm_artifact_count(engine, res.ingestion_id, model="fake-llm") == 1
    # same-model escalation adds no grounding -> still needs_review (no silent accept).
    assert _run_row(engine, res.ingestion_id)["outcome"] == "needs_review"
