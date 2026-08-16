"""HTTP adapter: POST /v1/auth/login — username/password -> signed JWT.

Unauthenticated by design (it is the credential exchange), like the ops endpoints.
On any failure it returns the generic UNAUTHENTICATED problem+json — never a detail
that distinguishes "unknown user" from "wrong password". On success it returns a
Bearer access token carrying the actor_id / principal / scopes / role claims that
the gate (``resolve_principal``) and the audit context already understand, so no
downstream router changes.
"""

from __future__ import annotations

import hashlib
import ipaddress
import os
import threading

from fastapi import APIRouter, Cookie, Depends, Path, Request, Response, status
from pydantic import BaseModel, Field

from labelscan.contexts.identity.application.login import InvalidCredentials, Login
from labelscan.contexts.identity.application.sessions import (
    InvalidRefreshToken,
    RefreshSession,
    SessionService,
)
from labelscan.contexts.identity.domain.user import (
    ADMIN_ROLE,
    MANAGER_ROLE,
    SUPER_ADMIN_ROLE,
    AuthenticatedUser,
)
from labelscan.platform.config import is_production, public_origin
from labelscan.platform.http import jwt as jwt_codec
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.rate_limit import LimitExceeded, rate_limits
from labelscan.platform.observability import get_logger

router = APIRouter()


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=128)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=32, max_length=256)


class CurrentUserResponse(BaseModel):
    id: str
    username: str
    display_name: str
    role: str
    store_code: str | None
    organization_id: str | None = None
    organization_slug: str = "labelscan"
    store_id: str | None = None
    business_portal_ids: list[str] = Field(default_factory=list)
    business_portal_id: str | None = None
    trade_code: str | None = None
    client_type: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: CurrentUserResponse


class MobileLoginResponse(LoginResponse):
    refresh_token: str
    refresh_expires_in: int


_LOGIN: Login | None = None
_LOGIN_LOCK = threading.Lock()
_SESSIONS: SessionService | None = None
_SESSIONS_LOCK = threading.Lock()
_REFRESH_COOKIE = "labelscan_refresh"
_REFRESH_COOKIE_PATH = "/v1/auth"
_log = get_logger("http.security")
_BROWSER_ROLES = frozenset(
    {SUPER_ADMIN_ROLE, ADMIN_ROLE, MANAGER_ROLE}
)


def get_login() -> Login:
    # Composition seam — overridden in tests. Built lazily from this context's own
    # adapter + the platform engine (never imports the app layer, preserving the
    # inward dependency direction). Cached so the engine is built once.
    global _LOGIN
    if _LOGIN is None:
        with _LOGIN_LOCK:
            if _LOGIN is None:
                from labelscan.contexts.identity.adapters.sql_user_repository import (
                    SqlUserRepository,
                )
                from labelscan.platform.db.engine import make_engine

                _LOGIN = Login(SqlUserRepository(make_engine()))
    return _LOGIN


def get_session_service() -> SessionService:
    global _SESSIONS
    if _SESSIONS is None:
        with _SESSIONS_LOCK:
            if _SESSIONS is None:
                from labelscan.contexts.identity.adapters.sql_session_repository import (
                    SqlSessionRepository,
                )
                from labelscan.platform.db.engine import make_engine

                _SESSIONS = SessionService(SqlSessionRepository(make_engine()))
    return _SESSIONS


def _account_key(organization_slug: str, username: str) -> str:
    normalized = f"{organization_slug.strip().lower()}:{username.strip().casefold()}"
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _client_ip(request: Request) -> str:
    peer = request.client.host if request.client else "unknown"
    trusted = {
        address.strip()
        for address in (os.environ.get("LABELSCAN_TRUSTED_PROXIES") or "").split(",")
        if address.strip()
    }
    if peer not in trusted:
        return peer
    forwarded = (request.headers.get("X-Forwarded-For") or "").split(",", 1)[0].strip()
    try:
        return str(ipaddress.ip_address(forwarded))
    except ValueError:
        return peer


def _rate_limit_error(exc: LimitExceeded) -> ApiError:
    return ApiError(
        "RATE_LIMITED",
        "authentication temporarily rate limited",
        headers={"Retry-After": str(exc.retry_after)},
    )


def _require_browser_origin(request: Request) -> None:
    if not is_production():
        return
    expected = public_origin()
    supplied = (request.headers.get("Origin") or "").strip().rstrip("/")
    if not expected or supplied != expected:
        raise ApiError("FORBIDDEN", "browser request origin is not allowed")


def _authenticated_user(
    body: LoginRequest,
    organization_slug: str,
    login_uc: Login,
    request: Request,
) -> AuthenticatedUser:
    account_key = _account_key(organization_slug, body.username)
    try:
        rate_limits.check_login(_client_ip(request), account_key)
    except LimitExceeded as exc:
        _log.warning(
            "rate_limited",
            extra={
                "rate_limit_scope": exc.scope,
                "retry_after": exc.retry_after,
                "path": request.url.path,
            },
        )
        raise _rate_limit_error(exc)
    try:
        user = login_uc(body.username, body.password, organization_slug)
    except InvalidCredentials:
        rate_limits.login_failed(_client_ip(request), account_key)
        # Single generic outcome — no username enumeration.
        raise ApiError("UNAUTHENTICATED", "invalid username or password")
    rate_limits.login_succeeded(account_key)
    return user


def _current_user(user: AuthenticatedUser, client_type: str) -> CurrentUserResponse:
    return CurrentUserResponse(
        id=user.actor_id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        store_code=user.store_code,
        organization_id=user.organization_id,
        organization_slug=user.organization_slug,
        store_id=user.store_id,
        business_portal_ids=list(user.business_portal_ids),
        business_portal_id=user.business_portal_id,
        trade_code=user.trade_code,
        client_type=client_type,
    )


def _is_authorized_mobile_user(user: AuthenticatedUser) -> bool:
    """Fail closed unless canonical claims describe one active portal and store.

    SQL-backed identities only receive portal/store claims after the repository has
    joined active assignments to an active portal and active store.  Rechecking the
    one-to-one shape here also protects alternate adapters and refresh responses.
    """

    portal_ids = tuple(dict.fromkeys(user.business_portal_ids))
    store_ids = tuple(dict.fromkeys(user.store_ids))
    return bool(
        user.role == MANAGER_ROLE
        and len(portal_ids) == 1
        and user.business_portal_id == portal_ids[0]
        and user.trade_code
        and user.store_id
        and len(store_ids) == 1
        and user.store_id == store_ids[0]
    )


def _access_token(session: RefreshSession) -> tuple[str, int]:
    user = session.user
    ttl = jwt_codec.default_ttl_seconds()
    token = jwt_codec.encode(
        {
            "sub": user.username,
            "actor_id": user.actor_id,  # recorded as the audit actor on writes
            "principal": user.username,  # idempotency scope
            "scopes": sorted(user.scopes),
            "role": user.role,
            "store_code": user.store_code,
            "organization_id": user.organization_id,
            "organization_slug": user.organization_slug,
            "store_id": user.store_id,
            "business_portal_ids": list(user.business_portal_ids),
            "business_portal_id": user.business_portal_id,
            "trade_code": user.trade_code,
            "store_ids": list(user.store_ids),
            "client_type": session.client_type,
            "sid": session.family_id,
        },
        ttl_seconds=ttl,
    )
    return token, ttl


def _login_response(session: RefreshSession) -> LoginResponse:
    token, ttl = _access_token(session)
    return LoginResponse(
        access_token=token,
        token_type="bearer",
        expires_in=ttl,
        user=_current_user(session.user, session.client_type),
    )


def _mobile_response(session: RefreshSession) -> MobileLoginResponse:
    base = _login_response(session)
    return MobileLoginResponse(
        **base.model_dump(),
        refresh_token=session.refresh_token,
        refresh_expires_in=session.refresh_expires_in,
    )


def _set_refresh_cookie(response: Response, session: RefreshSession) -> None:
    production = is_production()
    response.set_cookie(
        _REFRESH_COOKIE,
        session.refresh_token,
        max_age=session.refresh_expires_in,
        httponly=True,
        secure=production,
        samesite="strict",
        path=_REFRESH_COOKIE_PATH,
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        _REFRESH_COOKIE,
        path=_REFRESH_COOKIE_PATH,
        samesite="strict",
        secure=is_production(),
        httponly=True,
    )


def _browser_login(
    body: LoginRequest,
    request: Request,
    response: Response,
    organization_slug: str,
    login_uc: Login,
    sessions: SessionService,
) -> LoginResponse:
    _require_browser_origin(request)
    user = _authenticated_user(body, organization_slug, login_uc, request)
    if user.role not in _BROWSER_ROLES:
        raise ApiError("FORBIDDEN", "this account cannot access the web portal")
    session = sessions.create(user, "browser")
    _set_refresh_cookie(response, session)
    return _login_response(session)


@router.post(
    "/v1/auth/login",
    response_model=LoginResponse,
    status_code=status.HTTP_200_OK,
)
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    login_uc: Login = Depends(get_login),
    sessions: SessionService = Depends(get_session_service),
) -> LoginResponse:
    return _browser_login(body, request, response, "labelscan", login_uc, sessions)


@router.post(
    "/v1/o/{organization_slug}/auth/login",
    response_model=LoginResponse,
    status_code=status.HTTP_200_OK,
)
def organization_login(
    body: LoginRequest,
    request: Request,
    response: Response,
    organization_slug: str = Path(
        min_length=1,
        max_length=63,
        pattern=r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$",
    ),
    login_uc: Login = Depends(get_login),
    sessions: SessionService = Depends(get_session_service),
) -> LoginResponse:
    return _browser_login(
        body, request, response, organization_slug, login_uc, sessions
    )


@router.post(
    "/v1/mobile/auth/login",
    response_model=MobileLoginResponse,
    status_code=status.HTTP_200_OK,
)
def mobile_login(
    body: LoginRequest,
    request: Request,
    login_uc: Login = Depends(get_login),
    sessions: SessionService = Depends(get_session_service),
) -> MobileLoginResponse:
    user = _authenticated_user(body, "labelscan", login_uc, request)
    if not _is_authorized_mobile_user(user):
        raise ApiError(
            "FORBIDDEN",
            "the mobile application requires one active assigned portal",
        )
    return _mobile_response(sessions.create(user, "mobile"))


@router.post("/v1/mobile/auth/refresh", response_model=MobileLoginResponse)
def mobile_refresh(
    body: RefreshRequest,
    sessions: SessionService = Depends(get_session_service),
) -> MobileLoginResponse:
    try:
        session = sessions.rotate(body.refresh_token, "mobile")
    except InvalidRefreshToken:
        raise ApiError("UNAUTHENTICATED", "invalid or expired refresh token")
    if not _is_authorized_mobile_user(session.user):
        sessions.revoke(session.refresh_token)
        raise ApiError("FORBIDDEN", "this account has no active mobile portal")
    return _mobile_response(session)


@router.post("/v1/mobile/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def mobile_logout(
    body: RefreshRequest,
    sessions: SessionService = Depends(get_session_service),
) -> Response:
    sessions.revoke(body.refresh_token)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/v1/auth/refresh", response_model=LoginResponse)
def browser_refresh(
    request: Request,
    response: Response,
    refresh_token: str | None = Cookie(None, alias=_REFRESH_COOKIE),
    sessions: SessionService = Depends(get_session_service),
) -> LoginResponse:
    _require_browser_origin(request)
    try:
        session = sessions.rotate(refresh_token or "", "browser")
    except InvalidRefreshToken:
        _clear_refresh_cookie(response)
        raise ApiError("UNAUTHENTICATED", "invalid or expired refresh token")
    if session.user.role not in _BROWSER_ROLES:
        sessions.revoke(session.refresh_token)
        _clear_refresh_cookie(response)
        raise ApiError("FORBIDDEN", "this account cannot access the web portal")
    _set_refresh_cookie(response, session)
    return _login_response(session)


@router.post("/v1/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def browser_logout(
    request: Request,
    response: Response,
    refresh_token: str | None = Cookie(None, alias=_REFRESH_COOKIE),
    sessions: SessionService = Depends(get_session_service),
) -> Response:
    _require_browser_origin(request)
    sessions.revoke(refresh_token or "")
    _clear_refresh_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
