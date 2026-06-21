"""Principal resolution (platform / infra) — the authentication gate.

BACKEND §6. Every scoped endpoint depends on ``require_scope`` -> ``resolve_principal``.
This is the drop-in the original seam comment anticipated.

Primary path: a signed JWT, ``Authorization: Bearer <token>``, issued by
POST /v1/auth/login and verified here with the platform JWT codec — so no auth
*business logic* lives in this adapter (it only reads verified claims).

Legacy path: the identity-header seam (X-Actor-Id / X-Principal / X-Scopes), used
when an upstream gateway authenticates and forwards a trusted identity. It is
DISABLED by default (``LABELSCAN_ALLOW_HEADER_AUTH``) so forged identity headers are
never accepted by a directly-reachable API; enable it only behind a trusted
gateway. ``Principal`` and ``require_scope`` keep their exact shape, so no router
changes.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from fastapi import Request

from labelscan.platform.http import jwt as jwt_codec
from labelscan.platform.http.errors import ApiError


@dataclass(frozen=True)
class Principal:
    actor_id: str  # uuid of the authenticated actor (recorded in the audit context)
    principal: str  # logical principal (e.g. device id) — the idempotency scope
    scopes: frozenset[str]


_TRUTHY = {"1", "true", "yes", "on"}


def _header_auth_enabled() -> bool:
    return (
        os.environ.get("LABELSCAN_ALLOW_HEADER_AUTH") or ""
    ).strip().lower() in _TRUTHY


def _principal_from_bearer(token: str) -> Principal:
    try:
        claims = jwt_codec.decode(token)
    except jwt_codec.TokenError:
        raise ApiError("UNAUTHENTICATED", "invalid or expired token")
    actor_id = claims.get("actor_id")
    if not actor_id:
        raise ApiError("UNAUTHENTICATED", "token is missing the actor_id claim")
    principal = claims.get("principal") or actor_id
    raw_scopes = claims.get("scopes") or []
    if isinstance(raw_scopes, str):
        scopes = frozenset(raw_scopes.split())
    else:
        scopes = frozenset(str(s) for s in raw_scopes)
    return Principal(actor_id=str(actor_id), principal=str(principal), scopes=scopes)


def _principal_from_headers(request: Request) -> Principal:
    actor_id = request.headers.get("X-Actor-Id")
    if not actor_id:
        raise ApiError("UNAUTHENTICATED", "No authenticated principal")
    principal = request.headers.get("X-Principal") or actor_id
    scopes = frozenset((request.headers.get("X-Scopes") or "").split())
    return Principal(actor_id=actor_id, principal=principal, scopes=scopes)


def resolve_principal(request: Request) -> Principal:
    authorization = request.headers.get("Authorization")
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer" and token.strip():
            return _principal_from_bearer(token.strip())
        raise ApiError("UNAUTHENTICATED", "unsupported Authorization scheme")
    if _header_auth_enabled():
        return _principal_from_headers(request)
    raise ApiError("UNAUTHENTICATED", "No authenticated principal")


def require_scope(scope: str):
    def _dep(request: Request) -> Principal:
        principal = resolve_principal(request)
        if scope not in principal.scopes:
            raise ApiError("FORBIDDEN", f"requires scope '{scope}'")
        return principal

    return _dep
