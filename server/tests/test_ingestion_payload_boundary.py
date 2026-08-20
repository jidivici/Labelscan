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
from tests.conftest import bearer, jpeg_bytes

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
    overhead = len(jpeg_bytes())
    content = jpeg_bytes(b"x" * (10 * 1024 * 1024 - overhead))
    files, data = _files(content)
    r = client.post(
        "/v1/ingestions",
        files=files,
        data=data,
        headers={"Idempotency-Key": "k-10mb", **AUTH},
    )
    assert r.status_code == 202


def test_payload_just_over_10mb_rejected(client):
    overhead = len(jpeg_bytes())
    content = jpeg_bytes(b"x" * (10 * 1024 * 1024 + 1 - overhead))
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


def test_oversized_barcode_raw_is_rejected(client):
    long_barcode = "x" * 10000
    content = jpeg_bytes(b"barcode-boundary-test")
    files, data = _files(content, barcode_raw=long_barcode)
    r = client.post(
        "/v1/ingestions",
        files=files,
        data=data,
        headers={"Idempotency-Key": "k-long-barcode", **AUTH},
    )
    assert r.status_code == 400
    assert r.json()["error_code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize(
    ("content", "media"),
    [
        (b"\xff\xd8\xff\xc0\x00", "image/jpeg"),
        (jpeg_bytes(b"mislabeled"), "image/png"),
        (
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"
            + (10001).to_bytes(4, "big")
            + (1).to_bytes(4, "big"),
            "image/png",
        ),
    ],
)
def test_invalid_image_is_rejected_before_raw_persistence(
    client, engine, content, media
):
    with engine.connect() as conn:
        before = conn.execute(
            text("SELECT count(*) FROM ingestion.raw_artifact")
        ).scalar_one()
    files, data = _files(content, media=media)
    response = client.post(
        "/v1/ingestions",
        files=files,
        data=data,
        headers={"Idempotency-Key": f"invalid-{len(content)}-{media}", **AUTH},
    )
    assert response.status_code == 400
    with engine.connect() as conn:
        after = conn.execute(
            text("SELECT count(*) FROM ingestion.raw_artifact")
        ).scalar_one()
    assert after == before


def test_oversized_idempotency_key_is_rejected(client):
    response = client.post(
        "/v1/ingestions",
        files=_files(jpeg_bytes(b"valid"))[0],
        headers={"Idempotency-Key": "k" * 129, **AUTH},
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("barcode_raw", "valid\nforged"),
        ("barcode_raw", "visible\u202etxt.exe"),
        ("client_captured_at", "2026-08-20T10:00:00"),
        ("client_captured_at", "not-a-timestamp"),
    ],
)
def test_untrusted_ingestion_metadata_is_rejected(client, field, value):
    response = client.post(
        "/v1/ingestions",
        files=_files(jpeg_bytes(f"metadata-{field}-{value}".encode()))[0],
        data={field: value},
        headers={"Idempotency-Key": f"metadata-{field}", **AUTH},
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"


def test_idempotency_key_reuse_with_different_image_is_conflict(client):
    headers = {"Idempotency-Key": "stable-submit-key", **AUTH}
    first = client.post(
        "/v1/ingestions",
        files=_files(jpeg_bytes(b"idempotency-first"))[0],
        headers=headers,
    )
    conflict = client.post(
        "/v1/ingestions",
        files=_files(jpeg_bytes(b"idempotency-second"))[0],
        headers=headers,
    )
    assert first.status_code == 202
    assert conflict.status_code == 409
    assert conflict.json()["error_code"] == "IDEMPOTENCY_KEY_CONFLICT"
