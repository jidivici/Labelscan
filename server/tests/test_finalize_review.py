"""Atomic 17-field review, durable replay and catalogue projection proofs."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.adapters.http.router import (
    get_finalize_review,
    get_submit_ingestion,
)
from labelscan.contexts.ingestion.adapters.sql_ingestion_repository import (
    SqlIngestionRepository,
)
from labelscan.contexts.ingestion.adapters.sql_review_repository import (
    SqlReviewRepository,
)
from labelscan.contexts.ingestion.application.finalize_review import (
    FINAL_REVIEW_FIELDS,
    FinalizeReview,
)
from labelscan.contexts.ingestion.application.submit_ingestion import SubmitIngestion
from labelscan.contexts.ingestion.domain.extraction import RuleSet
from labelscan.contexts.traceability.adapters.registration_consumer import (
    RegistrationConsumer,
)
from labelscan.contexts.traceability.adapters.review_projection_consumer import (
    ReviewProjectionConsumer,
)
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.outbox.worker import OutboxWorker
from tests._fakes import OCR_TEXT, FakeLlm, FakeOcr, traceable_fields
from tests.conftest import bearer, jpeg_bytes

RULES = RuleSet(version="test", required_fields=frozenset({"scientific_name"}))


@pytest.fixture
def atomic_client(engine, raw_store):
    app = create_app()
    app.dependency_overrides[get_submit_ingestion] = lambda: SubmitIngestion(
        raw_store, SqlIngestionRepository(engine)
    )
    app.dependency_overrides[get_finalize_review] = lambda: FinalizeReview(
        SqlReviewRepository(engine)
    )
    return TestClient(app)


def _organization_id(engine) -> str:
    with engine.connect() as conn:
        return str(
            conn.execute(
                text("SELECT id FROM identity.organization WHERE slug = 'labelscan'")
            ).scalar_one()
        )


def _review_headers(engine, key: str) -> dict[str, str]:
    return {
        **bearer(
            "ingestion:write extraction:review catalog:read",
            principal="atomic-reviewer",
            role="super_admin",
            organization_id=_organization_id(engine),
        ),
        "Idempotency-Key": key,
    }


def _seed_review_ready(atomic_client, engine, raw_store) -> str:
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE platform.outbox SET published_at = now() "
                "WHERE published_at IS NULL"
            )
        )
    response = atomic_client.post(
        "/v1/ingestions",
        files={
            "image": (
                "label.jpg",
                jpeg_bytes(b"atomic-review-" + uuid.uuid4().hex.encode()),
                "image/jpeg",
            )
        },
        headers={
            **bearer(
                "ingestion:write",
                principal="atomic-reviewer",
                role="super_admin",
                organization_id=_organization_id(engine),
            ),
            "Idempotency-Key": f"submit-{uuid.uuid4().hex}",
        },
    )
    assert response.status_code == 202
    ingestion_id = response.json()["ingestion_id"]
    unique_lot = f"L{uuid.uuid4().hex[:12].upper()}"

    worker = OutboxWorker(engine)
    extraction = ExtractionConsumer(
        engine=engine,
        raw_store=raw_store,
        ocr=FakeOcr(f"{OCR_TEXT} Lot {unique_lot}"),
        llm=FakeLlm(traceable_fields(lot=unique_lot)),
        rule_set=RULES,
    )
    worker.register(extraction.event_type, extraction.consumer_name, extraction)
    worker.run_once()

    registration_worker = OutboxWorker(engine)
    registration = RegistrationConsumer(engine=engine)
    registration_worker.register(
        registration.event_type,
        registration.consumer_name,
        registration,
    )
    registration_worker.run_once()
    return ingestion_id


def _fields() -> dict[str, str | None]:
    fields = {name: "NC" for name in FINAL_REVIEW_FIELDS}
    fields.update(
        {
            "commercial_designation": "Cabillaud",
            "scientific_name": "Gadus morhua",
            "batch_number": "LOT-ATOMIC-01",
            "FAO_area": "27.8.b.1",
        }
    )
    return fields


def test_atomic_review_replays_without_duplicate_and_updates_projection(
    atomic_client, engine, raw_store
):
    ingestion_id = _seed_review_ready(atomic_client, engine, raw_store)
    key = f"review-{uuid.uuid4().hex}"
    request = {"fields": _fields(), "note": "Contrôle opérateur"}

    first = atomic_client.post(
        f"/v1/ingestions/{ingestion_id}/reviews",
        json=request,
        headers=_review_headers(engine, key),
    )
    second = atomic_client.post(
        f"/v1/ingestions/{ingestion_id}/reviews",
        json=request,
        headers=_review_headers(engine, key),
    )

    assert first.status_code == 200, first.text
    assert first.json()["replayed"] is False
    assert second.status_code == 200
    assert second.json() == {**first.json(), "replayed": True}

    with engine.connect() as conn:
        run_id = first.json()["run_id"]
        assert (
            conn.execute(
                text(
                    "SELECT count(*) FROM ingestion.extracted_field "
                    "WHERE extraction_run_id = :run_id"
                ),
                {"run_id": run_id},
            ).scalar_one()
            == 17
        )
        assert (
            conn.execute(
                text("SELECT status FROM ingestion.ingestion WHERE id = :ingestion_id"),
                {"ingestion_id": ingestion_id},
            ).scalar_one()
            == "confirmed"
        )

    projection_worker = OutboxWorker(engine)
    registration = RegistrationConsumer(engine=engine)
    projection_worker.register(
        registration.review_event_type,
        registration.consumer_name,
        registration,
    )
    projection = ReviewProjectionConsumer()
    projection_worker.register(
        projection.event_type,
        projection.consumer_name,
        projection,
    )
    projection_worker.run_once()
    with engine.connect() as conn:
        current = (
            conn.execute(
                text(
                    "SELECT fields, revision_no FROM traceability.arrival_projection "
                    "WHERE ingestion_id = :ingestion_id"
                ),
                {"ingestion_id": ingestion_id},
            )
            .mappings()
            .one()
        )
    assert current["fields"]["FAO_area"] == "27.8.b.1"
    assert current["revision_no"] == 1

    with engine.connect() as conn:
        finalized_fields = {
            row["field_name"]: (row["value"], row["source"], row["validation_status"])
            for row in conn.execute(
                text(
                    "SELECT field_name, value, source, validation_status "
                    "FROM ingestion.extracted_field WHERE extraction_run_id = :run_id"
                ),
                {"run_id": run_id},
            ).mappings()
        }
    assert finalized_fields["gtin"] == ("NC", "human", "present")


def test_final_review_registers_a_batch_when_the_initial_run_needed_review(
    atomic_client, engine
):
    """A human-completed review must become visible in the store catalogue.

    This covers the real operator path: the initial automated run is flagged for
    review, then its final human run is confirmed. Prior to this proof, only an
    initially-extracted run could create an arrival projection.
    """
    organization_id = _organization_id(engine)
    ingestion_id = str(uuid.uuid4())
    run_id = str(uuid.uuid4())
    with engine.begin() as conn:
        correlation_id = f"review-{uuid.uuid4().hex}"
        set_audit_context(
            conn,
            actor_id=str(uuid.uuid4()),
            action="ingestion.test_review_seeded",
            correlation_id=correlation_id,
            trace_id=correlation_id,
        )
        conn.execute(
            text(
                "INSERT INTO ingestion.ingestion "
                "(id, organization_id, status, image_ref, checksum_sha256, correlation_id, trace_id) "
                "VALUES (:id, :organization_id, 'needs_review', 'sha256://review', :checksum, :corr, :corr)"
            ),
            {
                "id": ingestion_id,
                "organization_id": organization_id,
                "checksum": uuid.uuid4().hex.ljust(64, "0"),
                "corr": correlation_id,
            },
        )
        conn.execute(
            text(
                "INSERT INTO ingestion.raw_artifact "
                "(organization_id, ingestion_id, artifact_kind, storage_ref, "
                "checksum_sha256, correlation_id, trace_id) "
                "VALUES (:organization_id, :ingestion_id, 'image', "
                "'sha256://review', :checksum, :corr, :corr)"
            ),
            {
                "organization_id": organization_id,
                "ingestion_id": ingestion_id,
                "checksum": uuid.uuid4().hex.ljust(64, "0"),
                "corr": correlation_id,
            },
        )
        conn.execute(
            text(
                "INSERT INTO ingestion.extraction_run "
                "(id, ingestion_id, attempt_no, outcome, extractor_version, prompt_version, "
                "ocr_provider, llm_model, rule_set_version, correlation_id, trace_id) "
                "VALUES (:id, :ingestion_id, 1, 'needs_review', 'test', 'test', 'test', 'test', 'test', :corr, :corr)"
            ),
            {
                "id": run_id,
                "ingestion_id": ingestion_id,
                "corr": correlation_id,
            },
        )

    response = atomic_client.post(
        f"/v1/ingestions/{ingestion_id}/reviews",
        json={"fields": _fields(), "note": "Validation opérateur"},
        headers=_review_headers(engine, f"review-{uuid.uuid4().hex}"),
    )
    assert response.status_code == 200, response.text

    worker = OutboxWorker(engine)
    registration = RegistrationConsumer(engine=engine)
    worker.register(
        registration.review_event_type, registration.consumer_name, registration
    )
    worker.run_once()

    with engine.connect() as conn:
        assert (
            conn.execute(
                text(
                    "SELECT count(*) FROM traceability.arrival_projection "
                    "WHERE ingestion_id = :ingestion_id"
                ),
                {"ingestion_id": ingestion_id},
            ).scalar_one()
            == 1
        )


def test_atomic_review_rejects_key_reuse_with_different_payload(
    atomic_client, engine, raw_store
):
    ingestion_id = _seed_review_ready(atomic_client, engine, raw_store)
    key = f"review-{uuid.uuid4().hex}"
    fields = _fields()
    first = atomic_client.post(
        f"/v1/ingestions/{ingestion_id}/reviews",
        json={"fields": fields},
        headers=_review_headers(engine, key),
    )
    assert first.status_code == 200

    changed = {**fields, "FAO_area": "37.1"}
    conflict = atomic_client.post(
        f"/v1/ingestions/{ingestion_id}/reviews",
        json={"fields": changed},
        headers=_review_headers(engine, key),
    )
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "IDEMPOTENCY_KEY_CONFLICT"


def test_atomic_review_requires_exact_contract(atomic_client, engine):
    fields = _fields()
    fields.pop("gtin")
    response = atomic_client.post(
        f"/v1/ingestions/{uuid.uuid4()}/reviews",
        json={"fields": fields},
        headers=_review_headers(engine, f"review-{uuid.uuid4().hex}"),
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"


def test_atomic_review_rejects_empty_values(atomic_client, engine):
    fields = _fields()
    fields["gtin"] = None
    response = atomic_client.post(
        f"/v1/ingestions/{uuid.uuid4()}/reviews",
        json={"fields": fields},
        headers=_review_headers(engine, f"review-{uuid.uuid4().hex}"),
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"
    assert "gtin" in response.json()["detail"]
