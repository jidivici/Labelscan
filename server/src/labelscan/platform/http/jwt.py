"""JWT codec (platform / infra) — symmetric HS256 for the simple admin auth.

This is the SINGLE place the token format and the signing secret live, so the
login adapter (which mints tokens) and ``resolve_principal`` (which verifies them
at the gate) cannot drift apart. There is NO auth *business logic* here: who may
log in, and which scopes 'admin' gets, are decided in the identity context. This
module only signs and verifies the envelope.

Secret resolution mirrors ``platform.db.engine``: read from the environment, never
a baked-in default — a missing secret is a hard error, not a silent insecure
fallback.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt

from labelscan.platform.config import jwt_audience, jwt_issuer, secret_value

_ALGORITHM = "HS256"
_DEFAULT_TTL_SECONDS = 15 * 60  # 15 minutes
_MAX_TTL_SECONDS = 60 * 60  # access tokens must remain short-lived


class TokenError(Exception):
    """A token could not be verified (bad signature, expired, or malformed)."""


_MIN_SECRET_BYTES = 32  # RFC 7518 §3.2 floor for HS256 (PyJWT warns below this)


def _secret() -> str:
    secret = secret_value("LABELSCAN_JWT_SECRET")
    if not secret:
        raise RuntimeError(
            "LABELSCAN_JWT_SECRET is not set. A signing secret is required for JWT auth."
        )
    if len(secret.encode("utf-8")) < _MIN_SECRET_BYTES:
        raise RuntimeError(
            f"LABELSCAN_JWT_SECRET is too short: HS256 requires at least {_MIN_SECRET_BYTES} bytes "
            "(RFC 7518 §3.2). Use a long random string."
        )
    return secret


def default_ttl_seconds() -> int:
    raw = os.environ.get("LABELSCAN_JWT_TTL_SECONDS")
    if not raw:
        return _DEFAULT_TTL_SECONDS
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(
            "LABELSCAN_JWT_TTL_SECONDS must be an integer (seconds)"
        ) from exc
    if value <= 0:
        raise RuntimeError(
            "LABELSCAN_JWT_TTL_SECONDS must be a positive number of seconds"
        )
    if value > _MAX_TTL_SECONDS:
        raise RuntimeError(
            f"LABELSCAN_JWT_TTL_SECONDS must not exceed {_MAX_TTL_SECONDS} seconds"
        )
    return value


def encode(claims: dict[str, Any], *, ttl_seconds: int | None = None) -> str:
    """Sign ``claims`` into a compact JWS, adding ``iat``/``exp``.

    The caller supplies the identity claims (sub / actor_id / principal / scopes /
    role); this only stamps issue + expiry times and signs.
    """
    now = datetime.now(timezone.utc)
    ttl = ttl_seconds if ttl_seconds is not None else default_ttl_seconds()
    if ttl <= 0 or ttl > _MAX_TTL_SECONDS:
        raise RuntimeError(
            f"access-token TTL must be between 1 and {_MAX_TTL_SECONDS} seconds"
        )
    payload = {
        **claims,
        "jti": claims.get("jti") or str(uuid.uuid4()),
        "iss": claims.get("iss") or jwt_issuer(),
        "aud": claims.get("aud") or jwt_audience(),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl)).timestamp()),
    }
    return jwt.encode(payload, _secret(), algorithm=_ALGORITHM)


def decode(token: str) -> dict[str, Any]:
    """Verify signature + expiry and return the claims. Raises ``TokenError`` on any failure."""
    try:
        return jwt.decode(
            token,
            _secret(),
            algorithms=[_ALGORITHM],
            issuer=jwt_issuer(),
            audience=jwt_audience(),
            options={"require": ["sub", "exp", "iat", "jti", "iss", "aud"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc
