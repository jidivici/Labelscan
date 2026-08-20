"""Fail-closed production configuration proofs."""

from __future__ import annotations

import pytest

from labelscan.platform.config import secret_value, validate_runtime_configuration


def _production_storage(monkeypatch) -> None:
    monkeypatch.setenv("LABELSCAN_ENV", "production")
    monkeypatch.setenv("LABELSCAN_OBJECT_STORE", "s3")
    monkeypatch.setenv("LABELSCAN_S3_BUCKET", "labelscan-production")
    monkeypatch.setenv("LABELSCAN_S3_REGION", "eu-west-3")
    monkeypatch.setenv("LABELSCAN_S3_ENCRYPTION", "aws:kms")
    monkeypatch.setenv("LABELSCAN_S3_KMS_KEY_ID", "kms-key")


def test_secret_file_is_supported_and_conflicts_fail(monkeypatch, tmp_path):
    secret_file = tmp_path / "jwt"
    secret_file.write_text("mounted-secret\n", encoding="utf-8")
    monkeypatch.setenv("EXAMPLE_SECRET_FILE", str(secret_file))
    assert secret_value("EXAMPLE_SECRET", required=True) == "mounted-secret"

    monkeypatch.setenv("EXAMPLE_SECRET", "inline-secret")
    with pytest.raises(RuntimeError, match="set only one"):
        secret_value("EXAMPLE_SECRET")


def test_production_database_requires_verified_tls(monkeypatch):
    _production_storage(monkeypatch)
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://app:secret@db/labelscan")
    with pytest.raises(RuntimeError, match="sslmode=verify-full"):
        validate_runtime_configuration("worker")


def test_single_vps_accepts_only_private_database_and_mounted_raw_store(monkeypatch):
    monkeypatch.setenv("LABELSCAN_ENV", "production")
    monkeypatch.setenv("LABELSCAN_DEPLOYMENT_TOPOLOGY", "single-vps")
    monkeypatch.setenv("LABELSCAN_OBJECT_STORE", "filesystem")
    monkeypatch.setenv("LABELSCAN_RAW_STORE_DIR", "/app/data/raw")
    monkeypatch.setenv(
        "DATABASE_URL", "postgresql+psycopg://app:secret@db:5432/labelscan"
    )
    monkeypatch.setenv("LABELSCAN_OCR_PROVIDER", "google")
    monkeypatch.setenv("LABELSCAN_GOOGLE_VISION_API_KEY", "vision-secret")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-secret")

    validate_runtime_configuration("worker")

    monkeypatch.setenv(
        "DATABASE_URL", "postgresql+psycopg://app:secret@database.example/labelscan"
    )
    with pytest.raises(RuntimeError, match="private db service"):
        validate_runtime_configuration("worker")

    monkeypatch.setenv(
        "DATABASE_URL", "postgresql+psycopg://app:secret@db:5432/labelscan"
    )
    monkeypatch.setenv("LABELSCAN_RAW_STORE_DIR", "/tmp/raw")
    with pytest.raises(RuntimeError, match="/app/data/raw"):
        validate_runtime_configuration("worker")


def test_production_api_requires_explicit_token_contract(monkeypatch):
    _production_storage(monkeypatch)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+psycopg://app:secret@db/labelscan?sslmode=verify-full",
    )
    monkeypatch.setenv("LABELSCAN_JWT_SECRET", "production-secret-0123456789abcdef")
    monkeypatch.setenv("LABELSCAN_PUBLIC_ORIGIN", "https://labels.example")
    monkeypatch.setenv("LABELSCAN_ALLOWED_HOSTS", "labels.example")
    monkeypatch.setenv("LABELSCAN_TRUSTED_PROXIES", "192.0.2.10")
    monkeypatch.setenv("LABELSCAN_VERSION", "test@sha256:abc")
    monkeypatch.delenv("LABELSCAN_JWT_ISSUER", raising=False)
    monkeypatch.delenv("LABELSCAN_JWT_AUDIENCE", raising=False)

    with pytest.raises(RuntimeError, match="LABELSCAN_JWT_ISSUER"):
        validate_runtime_configuration("api")


def test_production_accepts_private_proxy_cidr_but_rejects_public_cidr(monkeypatch):
    _production_storage(monkeypatch)
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+psycopg://app:secret@db/labelscan?sslmode=verify-full",
    )
    monkeypatch.setenv("LABELSCAN_JWT_SECRET", "production-secret-0123456789abcdef")
    monkeypatch.setenv("LABELSCAN_PUBLIC_ORIGIN", "https://labels.example")
    monkeypatch.setenv("LABELSCAN_ALLOWED_HOSTS", "labels.example")
    monkeypatch.setenv("LABELSCAN_VERSION", "test@sha256:abc")
    monkeypatch.setenv("LABELSCAN_JWT_ISSUER", "https://labels.example")
    monkeypatch.setenv("LABELSCAN_JWT_AUDIENCE", "labelscan-clients")
    monkeypatch.setenv("LABELSCAN_TRUSTED_PROXIES", "172.16.0.0/12")

    validate_runtime_configuration("api")

    monkeypatch.setenv("LABELSCAN_TRUSTED_PROXIES", "8.8.8.0/24")
    with pytest.raises(RuntimeError, match="private CIDRs"):
        validate_runtime_configuration("api")


def test_worker_accepts_orchestrator_secret_files(monkeypatch, tmp_path):
    _production_storage(monkeypatch)
    values = {
        "DATABASE_URL": (
            "postgresql+psycopg://app:secret@db/labelscan?sslmode=verify-full"
        ),
        "LABELSCAN_GOOGLE_VISION_API_KEY": "vision-secret",
        "ANTHROPIC_API_KEY": "anthropic-secret",
    }
    for name, value in values.items():
        path = tmp_path / name.lower()
        path.write_text(value + "\n", encoding="utf-8")
        monkeypatch.setenv(f"{name}_FILE", str(path))
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("LABELSCAN_OCR_PROVIDER", "google")

    validate_runtime_configuration("worker")
