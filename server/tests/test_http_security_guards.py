"""Production configuration and browser response hardening proofs."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from labelscan.app.http_app import create_app
from labelscan.contexts.ingestion.adapters.http.router import get_submit_ingestion
from labelscan.contexts.ingestion.application.submit_ingestion import IngestionAccepted
from labelscan.platform.http.middleware import IngestionRequestSizeLimitMiddleware
from labelscan.platform.http.security import enforce_api_authentication_surface
from tests.conftest import bearer, jpeg_bytes


def configure_production(monkeypatch) -> None:
    monkeypatch.setenv("LABELSCAN_ENV", "production")
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+psycopg://app:secret@db.example/labelscan?sslmode=verify-full",
    )
    monkeypatch.setenv(
        "LABELSCAN_JWT_SECRET", "production-test-secret-0123456789abcdef"
    )
    monkeypatch.setenv("LABELSCAN_JWT_ISSUER", "labelscan-api-test")
    monkeypatch.setenv("LABELSCAN_JWT_AUDIENCE", "labelscan-clients-test")
    monkeypatch.setenv("LABELSCAN_VERSION", "test@sha256:abc")
    monkeypatch.setenv("LABELSCAN_OBJECT_STORE", "s3")
    monkeypatch.setenv("LABELSCAN_S3_BUCKET", "labelscan-production")
    monkeypatch.setenv("LABELSCAN_S3_REGION", "eu-west-3")
    monkeypatch.setenv("LABELSCAN_S3_ENCRYPTION", "aws:kms")
    monkeypatch.setenv("LABELSCAN_S3_KMS_KEY_ID", "test-kms-key")
    monkeypatch.setenv("LABELSCAN_PUBLIC_ORIGIN", "https://testserver")
    monkeypatch.setenv("LABELSCAN_ALLOWED_HOSTS", "testserver")
    monkeypatch.setenv("LABELSCAN_TRUSTED_PROXIES", "127.0.0.1")


def test_production_rejects_header_auth(monkeypatch):
    configure_production(monkeypatch)
    monkeypatch.setenv("LABELSCAN_ALLOW_HEADER_AUTH", "1")
    with pytest.raises(RuntimeError, match="forbidden in production"):
        create_app()


def test_production_requires_explicit_runtime_configuration(monkeypatch):
    monkeypatch.setenv("LABELSCAN_ENV", "production")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL_FILE", raising=False)
    monkeypatch.delenv("LABELSCAN_OBJECT_STORE", raising=False)
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        create_app()


def test_production_disables_docs_and_rejects_unknown_hosts(monkeypatch):
    configure_production(monkeypatch)
    client = TestClient(create_app())
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
    assert (
        client.get("/v1/health/live", headers={"Host": "attacker.test"}).status_code
        == 400
    )


def test_production_responses_enable_hsts_and_api_content_is_non_executable(
    monkeypatch,
):
    configure_production(monkeypatch)
    response = TestClient(create_app()).get("/v1/health/live")
    assert response.headers["Strict-Transport-Security"] == (
        "max-age=31536000; includeSubDomains"
    )
    assert response.headers["Content-Security-Policy"] == (
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    )


def test_production_rejects_browser_auth_without_same_origin(monkeypatch):
    configure_production(monkeypatch)
    response = TestClient(create_app()).post(
        "/v1/auth/login",
        json={"username": "alice", "password": "not-a-real-password"},
    )
    assert response.status_code == 403
    assert response.json()["error_code"] == "FORBIDDEN"


def test_backoffice_response_has_security_headers():
    response = TestClient(create_app()).get("/backoffice/")
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Permissions-Policy"] == (
        "camera=(), microphone=(), geolocation=()"
    )
    csp = response.headers["Content-Security-Policy"]
    assert "default-src 'self'" in csp
    assert "frame-ancestors 'none'" in csp
    assert "object-src 'none'" in csp
    assert response.headers["Cross-Origin-Opener-Policy"] == "same-origin"


def test_api_responses_are_not_cacheable():
    response = TestClient(create_app()).get("/v1/health/live")
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["Pragma"] == "no-cache"


def test_authentication_payload_rejects_unknown_fields():
    response = TestClient(create_app()).post(
        "/v1/auth/login",
        json={"username": "alice", "password": "secret", "role": "super_admin"},
    )
    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"


def test_non_public_v1_route_cannot_start_without_authentication():
    from fastapi import FastAPI

    app = FastAPI()

    @app.get("/v1/accidental-public-route")
    def accidental_public_route():
        return {"secret": True}

    with pytest.raises(RuntimeError, match="GET /v1/accidental-public-route"):
        enforce_api_authentication_surface(app)


def test_ingestion_multipart_envelope_is_bounded_before_parsing():
    response = TestClient(create_app()).post(
        "/v1/ingestions",
        content=b"x" * (11 * 1024 * 1024 + 1),
        headers={"Content-Type": "multipart/form-data; boundary=probe"},
    )
    assert response.status_code == 413
    assert response.json()["error_code"] == "PAYLOAD_TOO_LARGE"


def test_actual_asgi_bytes_are_counted_even_with_content_length() -> None:
    called = False
    sent: list[dict] = []
    messages = iter(
        [
            {"type": "http.request", "body": b"12", "more_body": True},
            {"type": "http.request", "body": b"345", "more_body": False},
        ]
    )

    async def downstream(_scope, _receive, _send):
        nonlocal called
        called = True

    async def receive():
        return next(messages)

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "https",
        "path": "/v1/ingestions",
        "raw_path": b"/v1/ingestions",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"content-length", b"1"),
            (b"content-type", b"multipart/form-data; boundary=probe"),
        ],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 443),
        "state": {},
    }

    asyncio.run(
        IngestionRequestSizeLimitMiddleware(downstream, max_bytes=4)(
            scope, receive, send
        )
    )

    assert called is False
    assert next(message for message in sent if message["type"] == "http.response.start")[
        "status"
    ] == 413


class _SubmitStub:
    def __init__(self) -> None:
        self.calls = []

    def __call__(self, command):
        self.calls.append(command)
        return IngestionAccepted(
            ingestion_id="33333333-3333-3333-3333-333333333333",
            status="raw_stored",
            http_status=202,
            replayed=False,
        )


@pytest.mark.parametrize(
    "parts",
    [
        [
            ("image", ("label.jpg", jpeg_bytes(b"unknown"), "image/jpeg")),
            ("unexpected", (None, "value")),
        ],
        [
            ("image", ("label.jpg", jpeg_bytes(b"duplicate-field"), "image/jpeg")),
            ("barcode_raw", (None, "4006381333931")),
            ("barcode_raw", (None, "93000502900204")),
        ],
        [
            ("image", ("first.jpg", jpeg_bytes(b"first"), "image/jpeg")),
            ("image", ("second.jpg", jpeg_bytes(b"second"), "image/jpeg")),
        ],
        [
            ("image", ("label.jpg", jpeg_bytes(b"many-fields"), "image/jpeg")),
            ("unknown-1", (None, "1")),
            ("unknown-2", (None, "2")),
            ("unknown-3", (None, "3")),
            ("unknown-4", (None, "4")),
        ],
    ],
)
def test_ingestion_multipart_rejects_unknown_and_duplicate_fields(parts) -> None:
    use_case = _SubmitStub()
    app = create_app()
    app.dependency_overrides[get_submit_ingestion] = lambda: use_case

    response = TestClient(app).post(
        "/v1/ingestions",
        files=parts,
        headers={
            **bearer("ingestion:write"),
            "Idempotency-Key": "strict-multipart",
        },
    )

    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"
    assert use_case.calls == []
