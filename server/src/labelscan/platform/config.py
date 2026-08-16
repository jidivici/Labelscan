"""Fail-closed runtime configuration shared by process composition roots.

The domain and application layers never import this module. It is deliberately
small and dependency-light so API, worker, migration tooling, and adapters use
one interpretation of deployment mode and secret sources.
"""

from __future__ import annotations

import os
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

_ENVIRONMENTS = {"development", "test", "production"}
_TRUTHY = {"1", "true", "yes", "on"}
_DEFAULT_JWT_ISSUER = "labelscan-api"
_DEFAULT_JWT_AUDIENCE = "labelscan-clients"


def deployment_environment() -> str:
    value = (os.environ.get("LABELSCAN_ENV") or "development").strip().lower()
    if value not in _ENVIRONMENTS:
        raise RuntimeError("LABELSCAN_ENV must be development, test, or production")
    return value


def is_production() -> bool:
    return deployment_environment() == "production"


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUTHY


def secret_value(name: str, *, required: bool = False) -> str | None:
    """Read a secret from NAME or NAME_FILE, never both.

    ``*_FILE`` supports orchestrator-mounted secrets under ``/run/secrets`` and
    avoids placing credentials in image metadata or ``docker inspect`` output.
    """

    direct = os.environ.get(name)
    file_name = os.environ.get(f"{name}_FILE")
    if direct is not None and file_name:
        raise RuntimeError(f"set only one of {name} and {name}_FILE")
    if file_name:
        path = Path(file_name)
        try:
            if path.stat().st_size > 64 * 1024:
                raise RuntimeError(f"{name}_FILE exceeds the 64 KiB secret limit")
            value = path.read_text(encoding="utf-8").rstrip("\r\n")
        except OSError as exc:
            raise RuntimeError(f"unable to read {name}_FILE") from exc
    else:
        value = direct
    if value is not None and not value:
        value = None
    if required and value is None:
        raise RuntimeError(f"{name} or {name}_FILE is required")
    return value


def jwt_issuer() -> str:
    return (os.environ.get("LABELSCAN_JWT_ISSUER") or _DEFAULT_JWT_ISSUER).strip()


def jwt_audience() -> str:
    return (
        os.environ.get("LABELSCAN_JWT_AUDIENCE") or _DEFAULT_JWT_AUDIENCE
    ).strip()


def public_origin() -> str | None:
    raw = (os.environ.get("LABELSCAN_PUBLIC_ORIGIN") or "").strip().rstrip("/")
    return raw or None


def allowed_hosts() -> list[str]:
    return [
        host.strip().lower()
        for host in (os.environ.get("LABELSCAN_ALLOWED_HOSTS") or "").split(",")
        if host.strip()
    ]


def trusted_proxy_addresses() -> list[str]:
    return [
        address.strip()
        for address in (os.environ.get("LABELSCAN_TRUSTED_PROXIES") or "").split(",")
        if address.strip()
    ]


def _validate_database_transport(url: str) -> None:
    parsed = urlsplit(url)
    sslmode = parse_qs(parsed.query).get("sslmode", [""])[0].lower()
    if sslmode != "verify-full":
        raise RuntimeError(
            "production DATABASE_URL must use sslmode=verify-full"
        )


def _validate_public_http() -> None:
    origin = public_origin()
    if origin is None:
        raise RuntimeError("LABELSCAN_PUBLIC_ORIGIN is required in production")
    parsed = urlsplit(origin)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise RuntimeError(
            "LABELSCAN_PUBLIC_ORIGIN must be an HTTPS origin without path or credentials"
        )
    hosts = allowed_hosts()
    if not hosts or any("*" in host for host in hosts):
        raise RuntimeError(
            "LABELSCAN_ALLOWED_HOSTS must explicitly list production hosts"
        )
    if parsed.hostname.lower() not in hosts:
        raise RuntimeError(
            "LABELSCAN_PUBLIC_ORIGIN host must be present in LABELSCAN_ALLOWED_HOSTS"
        )
    proxies = trusted_proxy_addresses()
    if not proxies:
        raise RuntimeError("LABELSCAN_TRUSTED_PROXIES is required in production")
    try:
        for address in proxies:
            ip_address(address)
    except ValueError as exc:
        raise RuntimeError(
            "LABELSCAN_TRUSTED_PROXIES must contain exact IP addresses"
        ) from exc


def _validate_object_store() -> None:
    if (os.environ.get("LABELSCAN_OBJECT_STORE") or "").strip().lower() != "s3":
        raise RuntimeError("production requires LABELSCAN_OBJECT_STORE=s3")
    required = ("LABELSCAN_S3_BUCKET", "LABELSCAN_S3_REGION")
    missing = [name for name in required if not (os.environ.get(name) or "").strip()]
    if missing:
        raise RuntimeError("production object storage is missing: " + ", ".join(missing))
    endpoint = (os.environ.get("LABELSCAN_S3_ENDPOINT_URL") or "").strip()
    if endpoint and urlsplit(endpoint).scheme != "https":
        raise RuntimeError("production S3 endpoints must use HTTPS")
    if (os.environ.get("LABELSCAN_S3_ENCRYPTION") or "").strip() != "aws:kms":
        raise RuntimeError("production requires LABELSCAN_S3_ENCRYPTION=aws:kms")
    if not (os.environ.get("LABELSCAN_S3_KMS_KEY_ID") or "").strip():
        raise RuntimeError("LABELSCAN_S3_KMS_KEY_ID is required in production")


def validate_runtime_configuration(component: str) -> None:
    """Validate the security contract for ``api`` or ``worker`` startup."""

    if component not in {"api", "worker"}:
        raise RuntimeError("runtime component must be api or worker")
    environment = deployment_environment()
    if environment != "production":
        return

    if env_flag("LABELSCAN_ALLOW_HEADER_AUTH"):
        raise RuntimeError("LABELSCAN_ALLOW_HEADER_AUTH is forbidden in production")

    database = secret_value("DATABASE_URL", required=True)
    assert database is not None
    _validate_database_transport(database)
    _validate_object_store()

    if component == "api":
        jwt_secret = secret_value("LABELSCAN_JWT_SECRET", required=True)
        assert jwt_secret is not None
        if jwt_secret.startswith("change-me-"):
            raise RuntimeError("production JWT secret must not use the example placeholder")
        if not (os.environ.get("LABELSCAN_JWT_ISSUER") or "").strip():
            raise RuntimeError("LABELSCAN_JWT_ISSUER is required in production")
        if not (os.environ.get("LABELSCAN_JWT_AUDIENCE") or "").strip():
            raise RuntimeError("LABELSCAN_JWT_AUDIENCE is required in production")
        if not (os.environ.get("LABELSCAN_VERSION") or "").strip():
            raise RuntimeError("LABELSCAN_VERSION is required in production")
        _validate_public_http()
    else:
        if (os.environ.get("LABELSCAN_OCR_PROVIDER") or "").strip().lower() != "google":
            raise RuntimeError("production worker requires LABELSCAN_OCR_PROVIDER=google")
        secret_value("LABELSCAN_GOOGLE_VISION_API_KEY", required=True)
        secret_value("ANTHROPIC_API_KEY", required=True)
