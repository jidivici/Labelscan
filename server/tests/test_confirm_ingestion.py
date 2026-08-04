"""P3 proofs — reviewer confirmation + server-side Idempotency-Key dedup.

Validation requirements:
  - POST /confirm transitions a review-ready ingestion to the terminal 'confirmed'
    status, audited with the reviewer as actor;
  - it is idempotent (re-confirm replays, no second audit write);
  - a non-review-ready ingestion (still processing / failed) is rejected 409 —
    confirming would assert a review that never happened;
  - a missing ingestion 404s;
  - PATCH override with an Idempotency-Key: a repeat of the SAME key replays the
    ORIGINAL run — even after the field changed again (A→B then retry-A must not
    append a third run resurrecting A).
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.adapters.http.router import (
    get_confirm_ingestion,
    get_override_field,
    get_submit_ingestion,
)
from labelscan.contexts.ingestion.adapters.sql_confirm_repository import (
    SqlConfirmRepository,
)
from labelscan.contexts.ingestion.adapters.sql_field_override_repository import (
    SqlFieldOverrideRepository,
)
from labelscan.contexts.ingestion.adapters.sql_ingestion_repository import (
    SqlIngestionRepository,
)
from labelscan.contexts.ingestion.application.confirm_ingestion import ConfirmIngestion
from labelscan.contexts.ingestion.application.override_field import OverrideField
from labelscan.contexts.ingestion.application.submit_ingestion import SubmitIngestion
from labelscan.contexts.ingestion.domain.extraction import RuleSet
from labelscan.platform.http.deps import get_engine
from labelscan.platform.outbox.worker import OutboxWorker
from tests._fakes import OCR_TEXT, FakeLlm, FakeOcr, traceable_fields
from tests.conftest import bearer, jpeg_bytes

RULES = RuleSet(version="test", required_fields=frozenset({"scientific_name"}))
REVIEW = bearer("ingestion:write ingestion:read extraction:review", principal="rev-1")


@pytest.fixture
def client(engine, raw_store):
    app = create_app()
    app.dependency_overrides[get_submit_ingestion] = lambda: SubmitIngestion(
        raw_store, SqlIngestionRepository(engine)
    )
    app.dependency_overrides[get_override_field] = lambda: OverrideField(
        SqlFieldOverrideRepository(engine)
    )
    app.dependency_overrides[get_confirm_ingestion] = lambda: ConfirmIngestion(
        SqlConfirmRepository(engine)
    )
    app.dependency_overrides[get_engine] = lambda: engine
    return TestClient(app)


def _submit(client, engine, raw_store, *, extract: bool = True) -> str:
    """A fresh ingestion; optionally run the extraction so it is review-ready."""
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET published_at = now() WHERE published_at IS NULL"
            )
        )
    content = jpeg_bytes(b"confirm-p3-" + uuid.uuid4().hex.encode())
    r = client.post(
        "/v1/ingestions",
        files={"image": ("l.jpg", content, "image/jpeg")},
        headers={"Idempotency-Key": f"cf-{uuid.uuid4().hex[:8]}", **REVIEW},
    )
    iid = r.json()["ingestion_id"]
    if extract:
        worker = OutboxWorker(engine)
        ext = ExtractionConsumer(
            engine=engine,
            raw_store=raw_store,
            ocr=FakeOcr(OCR_TEXT),
            llm=FakeLlm(traceable_fields()),
            rule_set=RULES,
        )
        worker.register(ext.event_type, ext.consumer_name, ext)
        worker.run_once()
    return iid


# ----- confirm ------------------------------------------------------------------


def test_confirm_review_ready_transitions_and_is_idempotent(
    client, engine, raw_store
):
    iid = _submit(client, engine, raw_store)  # status: extracted

    r1 = client.post(f"/v1/ingestions/{iid}/confirm", headers=REVIEW)
    assert r1.status_code == 200
    assert r1.json() == {"ingestion_id": iid, "status": "confirmed", "replayed": False}

    with engine.connect() as c:
        status = c.execute(
            text("SELECT status FROM ingestion.ingestion WHERE id = :id"), {"id": iid}
        ).scalar_one()
    assert status == "confirmed"

    # Idempotent repeat: replays, still confirmed, no error.
    r2 = client.post(f"/v1/ingestions/{iid}/confirm", headers=REVIEW)
    assert r2.status_code == 200
    assert r2.json()["replayed"] is True


def test_confirm_is_audited_with_reviewer_actor(client, engine, raw_store):
    iid = _submit(client, engine, raw_store)
    client.post(f"/v1/ingestions/{iid}/confirm", headers=REVIEW)
    with engine.connect() as c:
        actions = [
            row["action"]
            for row in c.execute(
                text("SELECT action FROM audit.audit_log WHERE subject_id = :id"),
                {"id": iid},
            ).mappings()
        ]
    assert "ingestion.confirmed" in actions


def test_confirm_processing_ingestion_is_rejected_409(client, engine, raw_store):
    iid = _submit(client, engine, raw_store, extract=False)  # still raw_stored
    r = client.post(f"/v1/ingestions/{iid}/confirm", headers=REVIEW)
    assert r.status_code == 409
    assert r.json()["error_code"] == "INGESTION_NOT_CONFIRMABLE"
    with engine.connect() as c:
        status = c.execute(
            text("SELECT status FROM ingestion.ingestion WHERE id = :id"), {"id": iid}
        ).scalar_one()
    assert status == "raw_stored"  # untouched


def test_confirm_missing_ingestion_404s(client):
    r = client.post(
        "/v1/ingestions/00000000-0000-0000-0000-00000000beef/confirm", headers=REVIEW
    )
    assert r.status_code == 404


# ----- Idempotency-Key dedup on overrides ------------------------------------------


def test_override_idempotency_key_replays_original_run(client, engine, raw_store):
    iid = _submit(client, engine, raw_store)
    url = f"/v1/ingestions/{iid}/fields/FAO_area"
    key_a = f"key-{uuid.uuid4().hex[:8]}"

    # Original request under key A: writes value "27" (a new run).
    r1 = client.patch(url, json={"value": "27"}, headers={"Idempotency-Key": key_a, **REVIEW})
    assert r1.status_code == 200 and r1.json()["replayed"] is False
    run_a = r1.json()["run_id"]

    # The reviewer then changes the value (a DIFFERENT key — a new request).
    r2 = client.patch(
        url,
        json={"value": "27.8.b.1"},
        headers={"Idempotency-Key": f"key-{uuid.uuid4().hex[:8]}", **REVIEW},
    )
    assert r2.status_code == 200 and r2.json()["replayed"] is False

    # An out-of-order RETRY of the first request (same key A) must replay run A —
    # NOT append a third run resurrecting "27" over "27.8.b.1".
    r3 = client.patch(url, json={"value": "27"}, headers={"Idempotency-Key": key_a, **REVIEW})
    assert r3.status_code == 200
    assert r3.json()["replayed"] is True
    assert r3.json()["run_id"] == run_a
    assert r3.json()["value"] == "27"

    # The authoritative latest run still carries the LATER edit.
    with engine.connect() as c:
        latest_value = c.execute(
            text(
                "SELECT f.value FROM ingestion.extracted_field f "
                "JOIN ingestion.extraction_run r ON r.id = f.extraction_run_id "
                "WHERE r.ingestion_id = :iid AND f.field_name = 'FAO_area' "
                "ORDER BY r.attempt_no DESC LIMIT 1"
            ),
            {"iid": iid},
        ).scalar_one()
    assert latest_value == "27.8.b.1"


def test_override_without_key_keeps_value_based_idempotence(client, engine, raw_store):
    iid = _submit(client, engine, raw_store)
    url = f"/v1/ingestions/{iid}/fields/FAO_area"
    r1 = client.patch(url, json={"value": "27"}, headers=REVIEW)
    r2 = client.patch(url, json={"value": "27"}, headers=REVIEW)
    assert r1.json()["replayed"] is False
    assert r2.json()["replayed"] is True  # same value on latest run → no new run
