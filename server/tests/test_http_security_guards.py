"""Production configuration and browser response hardening proofs."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from labelscan.app.http_app import create_app


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
