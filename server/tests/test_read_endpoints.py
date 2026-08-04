"""PG-6 proofs — read-only endpoints.

No writes; reflects append-only nature (multiple extraction runs); returns
provenance, audit metadata, and status exactly as stored.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.haccp.adapters.alerting_consumer import AlertingConsumer
from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.adapters.http.router import get_submit_ingestion
from labelscan.contexts.ingestion.adapters.sql_ingestion_repository import (
    SqlIngestionRepository,
)
from labelscan.contexts.ingestion.application.submit_ingestion import SubmitIngestion
from labelscan.contexts.ingestion.domain.extraction import RuleSet
from labelscan.contexts.traceability.adapters.registration_consumer import (
    RegistrationConsumer,
)
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.http.deps import get_engine
from labelscan.platform.outbox.worker import OutboxWorker
from tests._fakes import FakeLlm, FakeOcr, traceable_fields
from tests.conftest import ACTOR_ID, bearer, jpeg_bytes

RULES = RuleSet(
    version="test",
    required_fields=frozenset({"scientific_name", "expiry_date", "production_method"}),
)
AUTH = bearer(
    "ingestion:write ingestion:read traceability:read haccp:read", principal="auditor-1"
)


@pytest.fixture
def client(engine, raw_store):
    app = create_app()
    app.dependency_overrides[get_submit_ingestion] = lambda: SubmitIngestion(
        raw_store, SqlIngestionRepository(engine)
    )
    app.dependency_overrides[get_engine] = lambda: engine
    return TestClient(app)


def _quiesce(engine):
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET published_at = now() WHERE published_at IS NULL"
            )
        )


def _seed_plan(engine):
    with engine.begin() as c:
        set_audit_context(
            c,
            actor_id=ACTOR_ID,
            action="haccp.plan_created",
            correlation_id="c",
            trace_id="t",
        )
        c.execute(
            text(
                "INSERT INTO haccp.control_plan (version, expiry_warning_days, active, correlation_id, trace_id) "
                "VALUES (:v, 7, true, 'c', 't')"
            ),
            {"v": f"plan-{uuid.uuid4().hex[:8]}"},
        )


# unique label identity so this test never collides with other tests' batches
READ_OCR = (
    "Cod (Gadus morhua) Supplier Read Supplier Co Wild caught FAO area 27 "
    "Use by 2026-06-20 Packed on 2026-06-10 Lot READLOT Atlantic Cod"
)
READ_FIELDS = traceable_fields(lot="READLOT", supplier="Read Supplier Co")


def _full_worker(engine, raw_store):
    w = OutboxWorker(engine)
    ext = ExtractionConsumer(
        engine=engine,
        raw_store=raw_store,
        ocr=FakeOcr(READ_OCR),
        llm=FakeLlm(READ_FIELDS),
        rule_set=RULES,
    )
    w.register(ext.event_type, ext.consumer_name, ext)
    reg = RegistrationConsumer(engine=engine)
    w.register(reg.event_type, reg.consumer_name, reg)
    al = AlertingConsumer(engine=engine, today=lambda: date(2026, 6, 18))
    for et in al.event_types:
        w.register(et, al.consumer_name, al)
    return w


def _extraction_only_worker(engine, raw_store):
    # OCR/LLM are deduped from the first run's stored artifacts, so inputs here are irrelevant.
    w = OutboxWorker(engine)
    ext = ExtractionConsumer(
        engine=engine,
        raw_store=raw_store,
        ocr=FakeOcr(READ_OCR),
        llm=FakeLlm(READ_FIELDS),
        rule_set=RULES,
    )
    w.register(ext.event_type, ext.consumer_name, ext)
    return w


@pytest.fixture
def seeded(client, engine, raw_store):
    """Create one ingestion, run extraction+traceability+haccp, then a 2nd
    extraction run (re-extraction) to exercise the multiple-runs read model."""
    _seed_plan(engine)
    _quiesce(engine)
    r = client.post(
        "/v1/ingestions",
        files={"image": ("l.jpg", jpeg_bytes(b"read-endpoints-1"), "image/jpeg")},
        headers={"Idempotency-Key": "rk", **AUTH},
    )
    ingestion_id = r.json()["ingestion_id"]
    _full_worker(engine, raw_store).run_once()

    # second extraction run for the same ingestion (append-only; new attempt)
    with engine.begin() as c:
        c.execute(
            text(
                "INSERT INTO platform.outbox (event_type, payload, correlation_id, trace_id) "
                "SELECT 'ingestion.raw_stored', jsonb_build_object("
                "'ingestion_id', id::text, 'organization_id', organization_id::text), "
                "'c', 't' FROM ingestion.ingestion WHERE id = :id"
            ),
            {"id": ingestion_id},
        )
    _extraction_only_worker(engine, raw_store).run_once()
    return ingestion_id


def test_get_ingestion_shows_all_runs_and_audit(client, seeded):
    r = client.get(f"/v1/ingestions/{seeded}", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] in ("extracted", "needs_review", "raw_stored")
    # append-only: BOTH extraction runs are returned, exactly one marked latest
    assert len(body["extraction_runs"]) == 2
    assert sorted(x["attempt_no"] for x in body["extraction_runs"]) == [1, 2]
    assert sum(1 for x in body["extraction_runs"] if x["is_latest"]) == 1
    # raw image + ocr_json + llm_output stored
    kinds = {a["artifact_kind"] for a in body["raw_artifacts"]}
    assert {"image", "ocr_json", "llm_output"} <= kinds
    # audit metadata
    assert (
        body["audit"]
        and body["audit"][0]["actor_id"]
        and body["audit"][0]["occurred_at"]
    )


def test_get_ingestion_embeds_latest_fields(client, engine, raw_store):
    # Self-contained (unique content + Idempotency-Key) so it does NOT inherit the shared
    # `seeded` idempotency/rawstore state. §1.3: the status response carries the latest
    # run's fields, so the polling client renders Review without a 2nd round-trip.
    _quiesce(engine)
    r = client.post(
        "/v1/ingestions",
        files={
            "image": (
                "l.jpg",
                jpeg_bytes(b"embed-latest-fields-1"),
                "image/jpeg",
            )
        },
        headers={"Idempotency-Key": "embed-latest-fields", **AUTH},
    )
    ingestion_id = r.json()["ingestion_id"]
    _extraction_only_worker(engine, raw_store).run_once()

    resp = client.get(f"/v1/ingestions/{ingestion_id}", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert body["latest_fields"] is not None
    sci = next(f for f in body["latest_fields"] if f["field_name"] == "scientific_name")
    assert sci["value"] == "Gadus morhua"  # the latest run's value, embedded
    assert sci["source"] in ("llm", "gs1", "human")


def test_get_extraction_run_shows_provenance_and_status(client, engine, seeded):
    with engine.connect() as c:
        run_id = c.execute(
            text(
                "SELECT id::text FROM ingestion.extraction_run WHERE ingestion_id = :i ORDER BY attempt_no LIMIT 1"
            ),
            {"i": seeded},
        ).scalar_one()
    r = client.get(f"/v1/extraction-runs/{run_id}", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["outcome"] == "extracted"
    sci = next(f for f in body["fields"] if f["field_name"] == "scientific_name")
    assert sci["value"] == "Gadus morhua"
    assert sci["validation_status"]  # status field present
    assert sci["provenance"] is not None
    assert sci["provenance"]["raw_artifact_id"]  # provenance: source
    assert sci["provenance"]["spans"]  # provenance: spans
    assert body["audit"] and body["audit"][0]["actor_id"]


def test_get_batch_shows_chain_alerts_and_status(client, engine, seeded):
    with engine.connect() as c:
        batch_id = c.execute(
            text(
                "SELECT id::text FROM traceability.batch WHERE source_ingestion_id = :i"
            ),
            {"i": seeded},
        ).scalar_one()
    r = client.get(f"/v1/batches/{batch_id}", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "registered"
    assert body["supplier_name"] == "Read Supplier Co"
    assert body["product_scientific_name"] == "Gadus morhua"
    assert any(a["alert_type"] == "expiry" for a in body["alerts"])
    assert body["audit"] and body["audit"][0]["occurred_at"]


def test_list_alerts_with_state_and_audit(client, seeded):
    r = client.get(
        "/v1/alerts", params={"state": "open", "alert_type": "expiry"}, headers=AUTH
    )
    assert r.status_code == 200
    body = r.json()
    assert body["limit"] == 50 and body["offset"] == 0
    assert len(body["items"]) >= 1
    item = body["items"][0]
    assert item["state"] == "open"  # status field
    assert item["audit"] is not None and item["audit"]["actor_id"]  # audit metadata


def test_unknown_ingestion_is_404(client):
    r = client.get(f"/v1/ingestions/{uuid.uuid4()}", headers=AUTH)
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["error_code"] == "NOT_FOUND"


def test_read_requires_scope(client, seeded):
    r = client.get(f"/v1/ingestions/{seeded}", headers=bearer("alert:read"))
    assert r.status_code == 403
    assert r.json()["error_code"] == "FORBIDDEN"
