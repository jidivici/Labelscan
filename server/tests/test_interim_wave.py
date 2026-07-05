"""Tier 3 wave-2 proofs (integration) — interim commit between OCR and LLM.

Validation requirements:
  - The worker writes deterministic preview fields + transits raw_stored -> ocr_done
    in its OWN committed transaction, then the final run supersedes (status extracted).
  - Redelivery/retry is idempotent: no duplicate interim rows, no status regression.
  - Fields the barcode actually resolved are NEVER previewed (GS1 is exact; a regex
    must not contradict it).
  - GET /v1/ingestions/{id} surfaces interim_fields ONLY while no run exists — a
    completed extraction never shows a stale preview as definitive.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.adapters.http.router import get_submit_ingestion
from labelscan.contexts.ingestion.adapters.sql_ingestion_repository import (
    SqlIngestionRepository,
)
from labelscan.contexts.ingestion.application.extraction_ports import OcrResult
from labelscan.contexts.ingestion.application.submit_ingestion import (
    SubmitIngestion,
    SubmitIngestionCommand,
)
from labelscan.contexts.ingestion.domain.extraction import RuleSet
from labelscan.platform.http.deps import get_engine
from labelscan.platform.outbox.worker import OutboxWorker
from tests._fakes import OCR_TEXT, FakeLlm, FakeOcr, good_fields
from tests.conftest import ACTOR_ID, bearer

RULES = RuleSet(
    version="test",
    required_fields=frozenset({"scientific_name", "expiry_date", "production_method"}),
)
AUTH = bearer("ingestion:read", principal="device-01")


@pytest.fixture
def client(engine, raw_store):
    app = create_app()
    app.dependency_overrides[get_submit_ingestion] = lambda: SubmitIngestion(
        raw_store, SqlIngestionRepository(engine)
    )
    app.dependency_overrides[get_engine] = lambda: engine
    return TestClient(app)


def _cmd(content: bytes, barcode_raw: str | None = None) -> SubmitIngestionCommand:
    return SubmitIngestionCommand(
        image_bytes=content,
        content_type="image/jpeg",
        actor_id=ACTOR_ID,
        correlation_id="corr-interim",
        trace_id="trace-interim",
        principal="device-01",
        barcode_raw=barcode_raw,
    )


def _quiesce(engine):
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET published_at = now() WHERE published_at IS NULL"
            )
        )


def _consumer(engine, raw_store, ocr=None, llm=None):
    return ExtractionConsumer(
        engine=engine,
        raw_store=raw_store,
        ocr=ocr or FakeOcr(),
        llm=llm or FakeLlm(good_fields()),
        rule_set=RULES,
    )


def _worker_with(engine, consumer) -> OutboxWorker:
    w = OutboxWorker(engine)
    w.register(consumer.event_type, consumer.consumer_name, consumer)
    return w


def _interim_rows(engine, ingestion_id) -> dict[str, str]:
    with engine.connect() as c:
        rows = (
            c.execute(
                text(
                    "SELECT field_name, value FROM ingestion.interim_field "
                    "WHERE ingestion_id = :id ORDER BY field_name"
                ),
                {"id": ingestion_id},
            )
            .mappings()
            .all()
        )
    return {r["field_name"]: r["value"] for r in rows}


def _status(engine, ingestion_id) -> str:
    with engine.connect() as c:
        return c.execute(
            text("SELECT status FROM ingestion.ingestion WHERE id = :id"),
            {"id": ingestion_id},
        ).scalar_one()


def _ocr_result(full_text: str) -> OcrResult:
    raw = json.dumps(
        {"full_text": full_text, "mean_confidence": 0.95, "page": 1}
    ).encode()
    return OcrResult(raw_json=raw, full_text=full_text, mean_confidence=0.95, page=1)


# ----- worker path -------------------------------------------------------------


def test_worker_writes_interim_then_final_run_supersedes(submit, engine, raw_store):
    _quiesce(engine)
    res = submit(_cmd(b"interim-happy-1"))
    _worker_with(engine, _consumer(engine, raw_store)).run_once()

    # Wave 2 was committed (from OCR_TEXT: use by / packed on / lot) …
    interim = _interim_rows(engine, res.ingestion_id)
    assert interim["expiry_date"] == "2026-06-20"
    assert interim["packaging_date"] == "2026-06-10"
    assert interim["batch_number"] == "L24-0917"
    # … and the FINAL status stands (ocr_done was a transit, not the outcome).
    assert _status(engine, res.ingestion_id) == "extracted"


def test_interim_commit_is_idempotent_and_never_regresses_status(
    submit, engine, raw_store
):
    _quiesce(engine)
    res = submit(_cmd(b"interim-idem-1"))
    consumer = _consumer(engine, raw_store)

    # Two interim commits (a crash-retry redelivery): one row set, no error.
    consumer._persist_interim(
        res.ingestion_id, _ocr_result(OCR_TEXT), (), "corr-interim", "trace-interim"
    )
    consumer._persist_interim(
        res.ingestion_id, _ocr_result(OCR_TEXT), (), "corr-interim", "trace-interim"
    )
    interim = _interim_rows(engine, res.ingestion_id)
    assert set(interim) == {"expiry_date", "packaging_date", "batch_number"}
    assert _status(engine, res.ingestion_id) == "ocr_done"

    # Full extraction then lands; a LATE interim redelivery must not regress it.
    _worker_with(engine, _consumer(engine, raw_store)).run_once()
    assert _status(engine, res.ingestion_id) == "extracted"
    consumer._persist_interim(
        res.ingestion_id, _ocr_result(OCR_TEXT), (), "corr-interim", "trace-interim"
    )
    assert _status(engine, res.ingestion_id) == "extracted"


def test_gs1_resolved_fields_are_not_previewed(submit, engine, raw_store):
    _quiesce(engine)
    # Barcode supplies the lot (AI 10) and the expiry (AI 17): those two are exact
    # and must NOT be previewed; packaging_date (print-only) still is.
    res = submit(_cmd(b"interim-gs1-1", barcode_raw="(10)L24-0917(17)260620"))
    _worker_with(engine, _consumer(engine, raw_store)).run_once()

    interim = _interim_rows(engine, res.ingestion_id)
    assert "batch_number" not in interim
    assert "expiry_date" not in interim
    assert interim["packaging_date"] == "2026-06-10"


# ----- read endpoint -----------------------------------------------------------


def test_status_endpoint_surfaces_interim_only_before_a_run(
    submit, engine, raw_store, client
):
    _quiesce(engine)
    res = submit(_cmd(b"interim-read-1"))
    consumer = _consumer(engine, raw_store)

    # Mid-flight (interim committed, LLM still "running"): preview + ocr_done visible.
    consumer._persist_interim(
        res.ingestion_id, _ocr_result(OCR_TEXT), (), "corr-interim", "trace-interim"
    )
    r = client.get(f"/v1/ingestions/{res.ingestion_id}", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ocr_done"
    assert body["latest_fields"] is None
    got = {f["field_name"]: f["value"] for f in body["interim_fields"]}
    assert got["expiry_date"] == "2026-06-20"
    assert all(f["source"] == "deterministic" for f in body["interim_fields"])

    # After the run lands: the preview is superseded — never shown again.
    _worker_with(engine, _consumer(engine, raw_store)).run_once()
    r = client.get(f"/v1/ingestions/{res.ingestion_id}", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "extracted"
    assert body["interim_fields"] is None
    assert body["latest_fields"] is not None
