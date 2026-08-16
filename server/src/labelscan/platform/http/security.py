"""Principal resolution (platform / infra) — the authentication gate.

BACKEND §6. Every scoped endpoint depends on ``require_scope`` -> ``resolve_principal``.
This is the drop-in the original seam comment anticipated.

Primary path: a signed JWT, ``Authorization: Bearer <token>``, issued by
POST /v1/auth/login and verified here with the platform JWT codec — so no auth
*business logic* lives in this adapter (it only reads verified claims).

Legacy path: the identity-header seam (X-Actor-Id / X-Principal / X-Scopes) is
available only for local compatibility tests. It is disabled by default and
forbidden in production, so a gateway cannot silently replace the signed-token
trust model. ``Principal`` and ``require_scope`` keep their exact shape.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request

from labelscan.platform.config import env_flag, is_production
from labelscan.platform.http import jwt as jwt_codec
from labelscan.platform.http.errors import ApiError


@dataclass(frozen=True)
class Principal:
    actor_id: str  # uuid of the authenticated actor (recorded in the audit context)
    principal: str  # logical principal (e.g. device id) — the idempotency scope
    scopes: frozenset[str]
    role: str = "operator"
    store_code: str | None = None
    organization_id: str | None = None
    organization_slug: str = "labelscan"
    store_id: str | None = None
    business_portal_ids: tuple[str, ...] = ()
    business_portal_id: str | None = None
    trade_code: str | None = None
    store_ids: tuple[str, ...] = ()
    client_type: str = "browser"


def _header_auth_enabled() -> bool:
    if is_production():
        if env_flag("LABELSCAN_ALLOW_HEADER_AUTH"):
            raise RuntimeError("LABELSCAN_ALLOW_HEADER_AUTH is forbidden in production")
        return False
    return env_flag("LABELSCAN_ALLOW_HEADER_AUTH")


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
    raw_store_code = claims.get("store_code")
    raw_organization_id = claims.get("organization_id")
    raw_organization_slug = claims.get("organization_slug")
    raw_store_id = claims.get("store_id")
    raw_portal_ids = claims.get("business_portal_ids") or []
    raw_primary_portal_id = claims.get("business_portal_id")
    raw_trade_code = claims.get("trade_code")
    raw_store_ids = claims.get("store_ids") or []
    raw_client_type = str(claims.get("client_type") or "browser")
    if not isinstance(raw_portal_ids, list) or not isinstance(raw_store_ids, list):
        raise ApiError("UNAUTHENTICATED", "token has invalid access claims")
    if raw_client_type not in {"browser", "mobile"}:
        raise ApiError("UNAUTHENTICATED", "token has invalid client claim")
    if is_production() and (not raw_organization_id or not raw_organization_slug):
        raise ApiError("UNAUTHENTICATED", "token is missing the tenant claim")
    session_id = claims.get("sid")
    if session_id:
        from labelscan.platform.http.session_validation import session_is_active

        if not session_is_active(str(session_id), str(actor_id)):
            raise ApiError("UNAUTHENTICATED", "session is revoked or expired")
    elif is_production():
        raise ApiError("UNAUTHENTICATED", "token is missing the session claim")
    return Principal(
        actor_id=str(actor_id),
        principal=str(principal),
        scopes=scopes,
        role=str(claims.get("role") or "operator"),
        store_code=str(raw_store_code) if raw_store_code else None,
        organization_id=(str(raw_organization_id) if raw_organization_id else None),
        organization_slug=str(raw_organization_slug or "labelscan"),
        store_id=str(raw_store_id) if raw_store_id else None,
        business_portal_ids=tuple(str(value) for value in raw_portal_ids),
        business_portal_id=(
            str(raw_primary_portal_id) if raw_primary_portal_id else None
        ),
        trade_code=str(raw_trade_code) if raw_trade_code else None,
        store_ids=tuple(str(value) for value in raw_store_ids),
        client_type=raw_client_type,
    )


def _principal_from_headers(request: Request) -> Principal:
    actor_id = request.headers.get("X-Actor-Id")
    if not actor_id:
        raise ApiError("UNAUTHENTICATED", "No authenticated principal")
    principal = request.headers.get("X-Principal") or actor_id
    scopes = frozenset((request.headers.get("X-Scopes") or "").split())
    return Principal(
        actor_id=actor_id,
        principal=principal,
        scopes=scopes,
        role=request.headers.get("X-Role") or "operator",
        store_code=request.headers.get("X-Store-Code"),
        organization_id=request.headers.get("X-Organization-Id"),
        organization_slug=request.headers.get("X-Organization-Slug") or "labelscan",
        store_id=request.headers.get("X-Store-Id"),
        business_portal_ids=tuple(
            value
            for value in (request.headers.get("X-Business-Portal-Ids") or "").split()
            if value
        ),
        business_portal_id=request.headers.get("X-Business-Portal-Id"),
        trade_code=request.headers.get("X-Trade-Code"),
        store_ids=tuple(
            value
            for value in (request.headers.get("X-Store-Ids") or "").split()
            if value
        ),
        client_type=request.headers.get("X-Client-Type") or "browser",
    )


def resolve_principal(request: Request) -> Principal:
    authorization = request.headers.get("Authorization")
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer" and token.strip():
            principal = _principal_from_bearer(token.strip())
            request.state.organization_id = principal.organization_id
            return principal
        raise ApiError("UNAUTHENTICATED", "unsupported Authorization scheme")
    if _header_auth_enabled():
        principal = _principal_from_headers(request)
        request.state.organization_id = principal.organization_id
        return principal
    raise ApiError("UNAUTHENTICATED", "No authenticated principal")


def require_scope(scope: str):
    def _dep(request: Request) -> Principal:
        principal = resolve_principal(request)
        if scope not in principal.scopes:
            raise ApiError("FORBIDDEN", f"requires scope '{scope}'")
        return principal

    return _dep
