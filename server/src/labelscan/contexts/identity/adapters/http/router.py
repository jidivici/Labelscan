"""HTTP adapter: POST /v1/auth/login — username/password -> signed JWT.

Unauthenticated by design (it is the credential exchange), like the ops endpoints.
On any failure it returns the generic UNAUTHENTICATED problem+json — never a detail
that distinguishes "unknown user" from "wrong password". On success it returns a
Bearer access token carrying the actor_id / principal / scopes / role claims that
the gate (``resolve_principal``) and the audit context already understand, so no
downstream router changes.
"""

from __future__ import annotations

import threading

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field

from labelscan.contexts.identity.application.login import InvalidCredentials, Login
from labelscan.platform.http import jwt as jwt_codec
from labelscan.platform.http.errors import ApiError

router = APIRouter()


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=1, max_length=1024)


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


_LOGIN: Login | None = None
_LOGIN_LOCK = threading.Lock()


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


@router.post(
    "/v1/auth/login", response_model=LoginResponse, status_code=status.HTTP_200_OK
)
def login(body: LoginRequest, login_uc: Login = Depends(get_login)) -> LoginResponse:
    try:
        user = login_uc(body.username, body.password)
    except InvalidCredentials:
        # Single generic outcome — no username enumeration.
        raise ApiError("UNAUTHENTICATED", "invalid username or password")

    ttl = jwt_codec.default_ttl_seconds()
    token = jwt_codec.encode(
        {
            "sub": user.username,
            "actor_id": user.actor_id,  # recorded as the audit actor on writes
            "principal": user.username,  # idempotency scope
            "scopes": sorted(user.scopes),
            "role": user.role,
        },
        ttl_seconds=ttl,
    )
    return LoginResponse(access_token=token, token_type="bearer", expires_in=ttl)
