"""Fix 4.2 — human override of an extracted field reaches the authoritative store.

Proves the cohérence guarantee: a reviewer's correction is persisted server-side,
append-only, auditable, source='human' — the original machine run is never overwritten
(ADR-0003/0005), and the read model returns the human-validated value.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.adapters.http.router import (
    get_override_field,
    get_submit_ingestion,
)
from labelscan.contexts.ingestion.adapters.sql_field_override_repository import (
    SqlFieldOverrideRepository,
)
from labelscan.contexts.ingestion.adapters.sql_ingestion_repository import (
    SqlIngestionRepository,
)
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
    app.dependency_overrides[get_engine] = lambda: engine
    return TestClient(app)


@pytest.fixture
def ingestion_id(client, engine, raw_store):
    """One ingestion with a single completed machine extraction run (no GS1 — the LLM
    fields stand alone, so FAO_area/supplier_name are source='llm' and overridable).

    Fully isolated: quiesce any outbox rows other tests left pending so our worker only
    processes OUR event, and use a unique image + Idempotency-Key so every test gets a
    fresh ingestion."""
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET published_at = now() WHERE published_at IS NULL"
            )
        )
    content = jpeg_bytes(b"override-4-2-" + uuid.uuid4().hex.encode())
    r = client.post(
        "/v1/ingestions",
        files={"image": ("l.jpg", content, "image/jpeg")},
        headers={"Idempotency-Key": f"ov-{uuid.uuid4().hex[:8]}", **REVIEW},
    )
    iid = r.json()["ingestion_id"]
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


def _runs(engine, iid):
    with engine.connect() as c:
        return (
            c.execute(
                text(
                    "SELECT id::text AS id, attempt_no FROM ingestion.extraction_run "
                    "WHERE ingestion_id = :i ORDER BY attempt_no"
                ),
                {"i": iid},
            )
            .mappings()
            .all()
        )


def _field_by_run(engine, iid, field_name):
    """[(attempt_no, value, source)] for one field across every run, oldest first."""
    with engine.connect() as c:
        return c.execute(
            text(
                "SELECT er.attempt_no AS attempt_no, ef.value AS value, ef.source AS source "
                "FROM ingestion.extracted_field ef "
                "JOIN ingestion.extraction_run er ON ef.extraction_run_id = er.id "
                "WHERE er.ingestion_id = :i AND ef.field_name = :f "
                "ORDER BY er.attempt_no"
            ),
            {"i": iid, "f": field_name},
        ).all()


def test_override_records_human_value_appends_run_and_retains_original(
    client, engine, ingestion_id
):
    # The exact audit scenario: a reviewer corrects FAO to full precision.
    r = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/FAO_area",
        json={"value": "27.8.b.1", "note": "Sous-zone lue sur l'étiquette"},
        headers={"Idempotency-Key": "k1", **REVIEW},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["value"] == "27.8.b.1"
    assert body["source"] == "human"
    assert body["replayed"] is False

    # Append-only: a NEW run was added; the original is retained unchanged.
    fao = _field_by_run(engine, ingestion_id, "FAO_area")
    assert [(a, v, s) for (a, v, s) in fao] == [
        (1, "27", "llm"),
        (2, "27.8.b.1", "human"),
    ]
    # Non-overridden fields are copied verbatim into the new run (machine provenance kept).
    sci = _field_by_run(engine, ingestion_id, "scientific_name")
    assert sci[-1][1] == "Gadus morhua" and sci[-1][2] == "llm"

    # The read model returns the human-validated value as the latest run.
    rid = _runs(engine, ingestion_id)[-1]["id"]
    run = client.get(f"/v1/extraction-runs/{rid}", headers=REVIEW).json()
    fao_field = next(f for f in run["fields"] if f["field_name"] == "FAO_area")
    assert fao_field["value"] == "27.8.b.1"
    assert fao_field["source"] == "human"


def test_repeated_identical_override_is_idempotent(client, engine, ingestion_id):
    body = {"value": "Corrected Supplier SARL"}
    first = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/supplier_name",
        json=body,
        headers={"Idempotency-Key": "s1", **REVIEW},
    )
    assert first.status_code == 200 and first.json()["replayed"] is False
    runs_after_first = len(_runs(engine, ingestion_id))

    second = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/supplier_name",
        json=body,
        headers={"Idempotency-Key": "s2", **REVIEW},
    )
    assert second.status_code == 200
    assert second.json()["replayed"] is True
    # No duplicate run for an identical re-submit.
    assert len(_runs(engine, ingestion_id)) == runs_after_first


def test_gs1_owned_field_cannot_be_overridden(client, ingestion_id):
    # Without the explicit force_gs1 flag the historical contract is unchanged.
    r = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/batch_number",
        json={"value": "TAMPERED"},
        headers=REVIEW,
    )
    assert r.status_code == 409
    assert r.json()["error_code"] == "FIELD_NOT_EDITABLE"


def test_gs1_override_with_force_appends_human_run(client, engine, ingestion_id):
    # Workflow v1: the operator may correct a barcode-derived field, but only under
    # the explicit flag — append-only, source='human', dedicated audit action.
    r = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/batch_number",
        json={"value": "LOT-CORRIGE-7", "force_gs1": True},
        headers={"Idempotency-Key": "g1", **REVIEW},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["value"] == "LOT-CORRIGE-7"
    assert body["source"] == "human"

    # Append-only: the machine value is retained on the original run.
    lots = _field_by_run(engine, ingestion_id, "batch_number")
    assert lots[0][2] != "human"
    assert lots[-1] == (lots[-1][0], "LOT-CORRIGE-7", "human")

    # The anomaly is queryable in the audit trail under its own action.
    with engine.connect() as c:
        action = c.execute(
            text(
                "SELECT action FROM audit.audit_log "
                "WHERE subject_table = 'extraction_run' AND subject_id = :rid"
            ),
            {"rid": body["run_id"]},
        ).scalar_one()
    assert action == "ingestion.gs1_field_overridden"


def test_gs1_override_force_is_idempotent(client, engine, ingestion_id):
    body = {"value": "LOT-REPLAY", "force_gs1": True}
    first = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/batch_number",
        json=body,
        headers={"Idempotency-Key": "g2", **REVIEW},
    )
    assert first.status_code == 200 and first.json()["replayed"] is False
    runs_after_first = len(_runs(engine, ingestion_id))

    second = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/batch_number",
        json=body,
        headers={"Idempotency-Key": "g2", **REVIEW},
    )
    assert second.status_code == 200
    assert second.json()["replayed"] is True
    assert len(_runs(engine, ingestion_id)) == runs_after_first


def test_force_flag_is_noop_on_regular_fields(client, engine, ingestion_id):
    # force_gs1 on a non-GS1 field changes nothing: ordinary audit action, normal path.
    r = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/FAO_area",
        json={"value": "37.1", "force_gs1": True},
        headers={"Idempotency-Key": "g3", **REVIEW},
    )
    assert r.status_code == 200, r.text
    with engine.connect() as c:
        action = c.execute(
            text(
                "SELECT action FROM audit.audit_log "
                "WHERE subject_table = 'extraction_run' AND subject_id = :rid"
            ),
            {"rid": r.json()["run_id"]},
        ).scalar_one()
    assert action == "ingestion.field_overridden"


def test_override_requires_review_scope(client, ingestion_id):
    r = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/FAO_area",
        json={"value": "37"},
        headers=bearer("ingestion:read"),  # no extraction:review
    )
    assert r.status_code == 403
    assert r.json()["error_code"] == "FORBIDDEN"


def test_override_unknown_ingestion_is_404(client):
    r = client.patch(
        f"/v1/ingestions/{uuid.uuid4()}/fields/FAO_area",
        json={"value": "37"},
        headers=REVIEW,
    )
    assert r.status_code == 404
    assert r.json()["error_code"] == "NOT_FOUND"


def test_override_key_cannot_be_reused_for_another_request(client, ingestion_id):
    headers = {"Idempotency-Key": "bound-override-key", **REVIEW}
    first = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/FAO_area",
        json={"value": "27.8.b.1"},
        headers=headers,
    )
    conflict = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/commercial_designation",
        json={"value": "Cabillaud"},
        headers=headers,
    )
    assert first.status_code == 200
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "IDEMPOTENCY_KEY_CONFLICT"


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("expiry_date", "2026-02-30"),
        ("production_method", "wild'; DROP TABLE ingestion.ingestion; --"),
        ("commercial_designation", "visible\u202etxt.exe"),
    ],
)
def test_override_rejects_malformed_or_spoofed_field_values(
    client, engine, ingestion_id, field_name, value
):
    before = len(_runs(engine, ingestion_id))
    response = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/{field_name}",
        json={"value": value},
        headers={"Idempotency-Key": f"invalid-{field_name}", **REVIEW},
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"
    assert len(_runs(engine, ingestion_id)) == before


def test_override_rejects_unknown_json_properties(client, ingestion_id):
    response = client.patch(
        f"/v1/ingestions/{ingestion_id}/fields/FAO_area",
        json={"value": "27", "organization_id": str(uuid.uuid4())},
        headers=REVIEW,
    )
    assert response.status_code == 400
