"""End-to-end proof of the hybrid GS1 + LLM path through the worker + DB.

Needs PostgreSQL (the engine fixture skips otherwise). Proves the whole chain:
submit (with a native GS1 barcode) -> OCR -> LLM -> gate -> GS1 reconciliation ->
GS1-aware outcome -> persisted extracted_field rows with source='gs1'/provenance.
"""

from __future__ import annotations

from sqlalchemy import text

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


def _quiesce(engine):
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET published_at = now() WHERE published_at IS NULL"
            )
        )


def _cmd(content: bytes, barcode_raw: str | None) -> SubmitIngestionCommand:
    return SubmitIngestionCommand(
        image_bytes=content,
        content_type="image/jpeg",
        actor_id=ACTOR_ID,
        correlation_id="corr-gs1",
        trace_id="trace-gs1",
        principal="device-01",
        barcode_raw=barcode_raw,
    )


def _run(engine, raw_store, ocr, llm, rules=RULES):
    consumer = ExtractionConsumer(
        engine=engine, raw_store=raw_store, ocr=ocr, llm=llm, rule_set=rules
    )
    w = OutboxWorker(engine)
    w.register(consumer.event_type, consumer.consumer_name, consumer)
    w.run_once()


def _field(engine, ingestion_id, name):
    with engine.connect() as c:
        return (
            c.execute(
                text(
                    "SELECT ef.value, ef.source, ef.confidence_band, ef.combined_confidence, "
                    "ef.provenance, ef.source_raw_artifact_id::text AS src, ef.warnings "
                    "FROM ingestion.extracted_field ef "
                    "JOIN ingestion.extraction_run er ON er.id = ef.extraction_run_id "
                    "WHERE er.ingestion_id = :i AND ef.field_name = :n"
                ),
                {"i": ingestion_id, "n": name},
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


def _image_artifact_id(engine, ingestion_id):
    with engine.connect() as c:
        return c.execute(
            text(
                "SELECT id::text FROM ingestion.raw_artifact "
                "WHERE ingestion_id = :i AND artifact_kind = 'image'"
            ),
            {"i": ingestion_id},
        ).scalar_one()


def test_gs1_fields_persisted_and_conflict_forces_review(submit, engine, raw_store):
    # LLM read expiry '2026-06-20' (grounded); the barcode says lot 2548541 + DLC 2025-12-31.
    _quiesce(engine)
    res = submit(_cmd(b"gs1-conflict-1", barcode_raw="(10)2548541(17)251231"))
    _run(engine, raw_store, FakeOcr(), FakeLlm(good_fields()))

    # batch_number comes from GS1 (the LLM never produced it) — exact, with provenance.
    lot = _field(engine, res.ingestion_id, "batch_number")
    assert lot["value"] == "2548541"
    assert lot["source"] == "gs1"
    assert lot["confidence_band"] == "high"
    assert float(lot["combined_confidence"]) == 1.0
    assert lot["provenance"] == {"source": "gs1", "ai": "10"}
    assert lot["src"] == _image_artifact_id(
        engine, res.ingestion_id
    )  # GS1 provenance -> the image

    # expiry: GS1 overrides the divergent LLM value, conflict recorded.
    exp = _field(engine, res.ingestion_id, "expiry_date")
    assert exp["value"] == "2025-12-31"
    assert exp["source"] == "gs1"
    assert any("Conflit" in w and "2026-06-20" in w for w in exp["warnings"])

    # D1: a barcode<->print conflict on the DLC forces review (zero-hallucination data, human sees the mismatch).
    assert _status(engine, res.ingestion_id) == "needs_review"


def test_gs1_fills_missing_required_upgrades_to_extracted(submit, engine, raw_store):
    # The LLM omits expiry entirely; the barcode supplies it -> Option Y -> extracted.
    _quiesce(engine)
    rules = RuleSet(
        version="test", required_fields=frozenset({"scientific_name", "expiry_date"})
    )
    llm_fields = (
        field("scientific_name", "Gadus morhua", 0.96, ["Gadus morhua"]),
        field("production_method", "wild_caught", 0.93, ["Wild caught"]),
    )
    res = submit(_cmd(b"gs1-fill-2", barcode_raw="(17)251231"))
    _run(engine, raw_store, FakeOcr(), FakeLlm(llm_fields), rules=rules)

    exp = _field(engine, res.ingestion_id, "expiry_date")
    assert exp["value"] == "2025-12-31" and exp["source"] == "gs1"
    # missing_required(expiry_date) cleared by GS1, no other reason -> extracted.
    assert _status(engine, res.ingestion_id) == "extracted"
