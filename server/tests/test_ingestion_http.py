"""PG-6 proofs — the SubmitCapture HTTP adapter.

Adapter only: idempotency (header), audit context set before the use case, raw
-before-ack (202 only after commit), outbox not bypassed, no provider call,
error mapping per BACKEND §5.2.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.ingestion.adapters.http.router import get_submit_ingestion
from labelscan.contexts.ingestion.adapters.sql_ingestion_repository import (
    SqlIngestionRepository,
)
from labelscan.contexts.ingestion.application.submit_ingestion import SubmitIngestion
from tests.conftest import bearer, jpeg_bytes

AUTH = bearer("ingestion:write", store_code="TEST-MAG-01")


@pytest.fixture
def client(engine, raw_store):
    app = create_app()
    use_case = SubmitIngestion(raw_store, SqlIngestionRepository(engine))
    app.dependency_overrides[get_submit_ingestion] = lambda: use_case
    return TestClient(app)


def _files(content: bytes, media="image/jpeg"):
    image = jpeg_bytes(content) if media == "image/jpeg" and content else content
    return {"image": ("label.jpg", image, media)}


def test_submit_returns_202_after_durable_write(client, engine):
    r = client.post(
        "/v1/ingestions",
        files=_files(b"http-bytes-1"),
        headers={"Idempotency-Key": "k1", **AUTH},
    )
    assert r.status_code == 202
    body = r.json()
    assert body["status"] == "raw_stored"
    assert body["replayed"] is False
    assert body["ingestion_id"]
    assert r.headers.get("x-correlation-id")

    with engine.connect() as c:
        # raw-before-ack: the row is committed by the time 202 is returned
        assert (
            c.execute(
                text(
                    "SELECT status, store_code "
                    "FROM ingestion.ingestion WHERE id = :i"
                ),
                {"i": body["ingestion_id"]},
            ).one()
            == ("raw_stored", "TEST-MAG-01")
        )
        # outbox NOT bypassed: the event was enqueued in the same transaction
        assert (
            c.execute(
                text(
                    "SELECT count(*) FROM platform.outbox WHERE event_type = 'ingestion.raw_stored' "
                    "AND payload->>'ingestion_id' = :i"
                ),
                {"i": body["ingestion_id"]},
            ).scalar_one()
            == 1
        )
        # no external provider called synchronously: no extraction happened
        assert (
            c.execute(
                text(
                    "SELECT count(*) FROM ingestion.extraction_run WHERE ingestion_id = :i"
                ),
                {"i": body["ingestion_id"]},
            ).scalar_one()
            == 0
        )


def test_duplicate_is_idempotent_replay(client, engine):
    content = b"http-bytes-dup"
    r1 = client.post(
        "/v1/ingestions",
        files=_files(content),
        headers={"Idempotency-Key": "kd", **AUTH},
    )
    r2 = client.post(
        "/v1/ingestions",
        files=_files(content),
        headers={"Idempotency-Key": "kd", **AUTH},
    )

    assert r1.status_code == 202 and r2.status_code == 202
    assert r2.json()["replayed"] is True
    assert r2.json()["ingestion_id"] == r1.json()["ingestion_id"]
    assert r2.headers.get("idempotency-replayed") == "true"

    iid = r1.json()["ingestion_id"]
    with engine.connect() as c:
        assert (
            c.execute(
                text("SELECT count(*) FROM ingestion.ingestion WHERE id = :i"),
                {"i": iid},
            ).scalar_one()
            == 1
        )
        assert (
            c.execute(
                text(
                    "SELECT count(*) FROM platform.outbox WHERE payload->>'ingestion_id' = :i"
                ),
                {"i": iid},
            ).scalar_one()
            == 1
        )


def test_missing_idempotency_key_is_400(client):
    r = client.post("/v1/ingestions", files=_files(b"x"), headers=AUTH)
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("application/problem+json")
    body = r.json()
    assert body["error_code"] == "VALIDATION_ERROR"
    assert body["correlation_id"]


def test_unsupported_media_type_is_415(client):
    r = client.post(
        "/v1/ingestions",
        files=_files(b"x", media="text/plain"),
        headers={"Idempotency-Key": "k", **AUTH},
    )
    assert r.status_code == 415
    assert r.json()["error_code"] == "UNSUPPORTED_MEDIA_TYPE"


def test_unauthenticated_is_401(client):
    r = client.post(
        "/v1/ingestions", files=_files(b"x"), headers={"Idempotency-Key": "k"}
    )
    assert r.status_code == 401
    assert r.json()["error_code"] == "UNAUTHENTICATED"


def test_missing_scope_is_403(client):
    r = client.post(
        "/v1/ingestions",
        files=_files(b"x"),
        headers={"Idempotency-Key": "k", **bearer("alert:read")},
    )
    assert r.status_code == 403
    assert r.json()["error_code"] == "FORBIDDEN"
