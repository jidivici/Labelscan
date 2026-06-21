"""Integration proofs — ingestion HTTP payload boundary checks.

Verifies the 10 MB payload limit boundary, oversized barcode_raw rejection,
and empty payload rejection.
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
from tests.conftest import bearer

AUTH = bearer("ingestion:write")


@pytest.fixture
def client(engine, raw_store):
    app = create_app()
    use_case = SubmitIngestion(raw_store, SqlIngestionRepository(engine))
    app.dependency_overrides[get_submit_ingestion] = lambda: use_case
    return TestClient(app)


def _files(content: bytes, media="image/jpeg", barcode_raw=None):
    files = {"image": ("label.jpg", content, media)}
    data = {}
    if barcode_raw is not None:
        data["barcode_raw"] = barcode_raw
    return files, data


def test_payload_exactly_10mb_accepted(client):
    content = b"x" * (10 * 1024 * 1024)
    files, data = _files(content)
    r = client.post(
        "/v1/ingestions",
        files=files,
        data=data,
        headers={"Idempotency-Key": "k-10mb", **AUTH},
    )
    assert r.status_code == 202


def test_payload_just_over_10mb_rejected(client):
    content = b"x" * (10 * 1024 * 1024 + 1)
    files, data = _files(content)
    r = client.post(
        "/v1/ingestions",
        files=files,
        data=data,
        headers={"Idempotency-Key": "k-over", **AUTH},
    )
    assert r.status_code == 413
    assert r.json()["error_code"] == "PAYLOAD_TOO_LARGE"


def test_empty_payload_rejected(client):
    files, data = _files(b"")
    r = client.post(
        "/v1/ingestions",
        files=files,
        data=data,
        headers={"Idempotency-Key": "k-empty", **AUTH},
    )
    assert r.status_code == 400


def test_oversized_barcode_raw_accepted_but_truncated(client, engine):
    long_barcode = "x" * 10000
    content = b"barcode-boundary-test"
    files, data = _files(content, barcode_raw=long_barcode)
    r = client.post(
        "/v1/ingestions",
        files=files,
        data=data,
        headers={"Idempotency-Key": "k-long-barcode", **AUTH},
    )
    assert r.status_code == 202
    iid = r.json()["ingestion_id"]
    with engine.connect() as c:
        stored = c.execute(
            text("SELECT barcode_raw FROM ingestion.ingestion WHERE id = :id"),
            {"id": iid},
        ).scalar_one()
    assert stored == long_barcode
