"""Back-office user administration HTTP adapter.

All endpoints require the ``identity:admin`` capability. Passwords are accepted
only on writes and are never returned; account removal is represented by the
reversible ``active=false`` state.
"""

from __future__ import annotations

import threading
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response, status
from pydantic import BaseModel, Field

from labelscan.contexts.identity.application.manage_users import (
    CreateUserCommand,
    UpdateUserCommand,
    UserAdminService,
)
from labelscan.contexts.identity.application.ports import (
    LastActiveAdmin,
    SelfAccessChangeNotAllowed,
    UsernameAlreadyExists,
    UserNotFound,
)
from labelscan.contexts.identity.application.store_ports import (
    StoreInactive,
    StoreNotFound,
    StoreRequired,
)
from labelscan.contexts.identity.domain.user import ManagedUser
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.security import Principal, require_scope

router = APIRouter()
Role = Literal["admin", "operator"]

_SERVICE: UserAdminService | None = None
_SERVICE_LOCK = threading.Lock()


def get_user_admin_service() -> UserAdminService:
    global _SERVICE
    if _SERVICE is None:
        with _SERVICE_LOCK:
            if _SERVICE is None:
                from labelscan.contexts.identity.adapters.sql_user_repository import (
                    SqlUserRepository,
                )
                from labelscan.platform.db.engine import make_engine

                _SERVICE = UserAdminService(SqlUserRepository(make_engine()))
    return _SERVICE


class UserResponse(BaseModel):
    id: str
    username: str
    display_name: str
    role: Role
    active: bool
    store_code: str | None
    created_by: str
    created_at: str
    updated_at: str
    organization_id: str | None = None
    store_id: str | None = None

    @classmethod
    def from_domain(cls, user: ManagedUser) -> "UserResponse":
        return cls(
            id=user.id,
            username=user.username,
            display_name=user.display_name,
            role=user.role,  # type: ignore[arg-type]
            active=user.active,
            store_code=user.store_code,
            created_by=user.created_by,
            created_at=user.created_at,
            updated_at=user.updated_at,
            organization_id=user.organization_id,
            store_id=user.store_id,
        )


class UserPage(BaseModel):
    items: list[UserResponse]
    total: int
    limit: int
    offset: int


class CreateUserRequest(BaseModel):
    username: str = Field(min_length=1, max_length=254)
    display_name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=12, max_length=128)
    role: Role = "operator"
    store_code: str | None = Field(None, max_length=64)


class UpdateUserRequest(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=120)
    password: str | None = Field(None, min_length=12, max_length=128)
    role: Role | None = None
    active: bool | None = None
    store_code: str | None = Field(None, max_length=64)


def _map_write_error(exc: Exception) -> None:
    if isinstance(exc, UsernameAlreadyExists):
        raise ApiError("USER_ALREADY_EXISTS", "username is already in use")
    if isinstance(exc, UserNotFound):
        raise ApiError("NOT_FOUND", "user not found")
    if isinstance(exc, StoreNotFound):
        raise ApiError("STORE_NOT_FOUND", "store code does not exist")
    if isinstance(exc, StoreInactive):
        raise ApiError("STORE_INACTIVE", "store is disabled")
    if isinstance(exc, StoreRequired):
        raise ApiError("STORE_REQUIRED", "an operator must be assigned to a store")
    if isinstance(exc, LastActiveAdmin):
        raise ApiError(
            "LAST_ACTIVE_ADMIN",
            "at least one active administrator must remain",
        )
    if isinstance(exc, SelfAccessChangeNotAllowed):
        raise ApiError(
            "SELF_ACCESS_CHANGE_NOT_ALLOWED",
            "an administrator cannot revoke their own administration access",
        )
    if isinstance(exc, ValueError):
        raise ApiError("VALIDATION_ERROR", str(exc))
    raise exc


@router.post(
    "/v1/users",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_user(
    body: CreateUserRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:admin")),
    service: UserAdminService = Depends(get_user_admin_service),
) -> UserResponse:
    try:
        user = service.create(
            CreateUserCommand(
                username=body.username,
                display_name=body.display_name,
                password=body.password,
                role=body.role,
                store_code=body.store_code,
                actor_id=principal.actor_id,
                correlation_id=request.state.correlation_id,
                trace_id=request.state.trace_id,
                organization_id=principal.organization_id,
            )
        )
    except Exception as exc:
        _map_write_error(exc)
        raise  # pragma: no cover - _map_write_error either raises or rethrows
    return UserResponse.from_domain(user)


@router.get("/v1/users", response_model=UserPage)
def list_users(
    role: Role | None = Query(None),
    active: bool | None = Query(None),
    store_code: str | None = Query(None, max_length=64),
    q: str | None = Query(None, max_length=120),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    principal: Principal = Depends(require_scope("identity:admin")),
    service: UserAdminService = Depends(get_user_admin_service),
) -> UserPage:
    try:
        users, total = service.list(
            organization_id=principal.organization_id,
            role=role,
            active=active,
            store_code=store_code,
            query=q,
            limit=limit,
            offset=offset,
        )
    except ValueError as exc:
        raise ApiError("VALIDATION_ERROR", str(exc))
    return UserPage(
        items=[UserResponse.from_domain(user) for user in users],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.patch("/v1/users/{user_id}", response_model=UserResponse)
def update_user(
    user_id: UUID,
    body: UpdateUserRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:admin")),
    service: UserAdminService = Depends(get_user_admin_service),
) -> UserResponse:
    try:
        user = service.update(
            UpdateUserCommand(
                user_id=str(user_id),
                actor_id=principal.actor_id,
                correlation_id=request.state.correlation_id,
                trace_id=request.state.trace_id,
                organization_id=principal.organization_id,
                display_name=body.display_name,
                password=body.password,
                role=body.role,
                active=body.active,
                store_code=body.store_code,
            )
        )
    except Exception as exc:
        _map_write_error(exc)
        raise  # pragma: no cover - _map_write_error either raises or rethrows
    return UserResponse.from_domain(user)


@router.delete(
    "/v1/users/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
def delete_user(
    user_id: UUID,
    request: Request,
    principal: Principal = Depends(require_scope("identity:admin")),
    service: UserAdminService = Depends(get_user_admin_service),
) -> Response:
    """Soft-delete an account while preserving its audit history."""
    try:
        service.update(
            UpdateUserCommand(
                user_id=str(user_id),
                actor_id=principal.actor_id,
                correlation_id=request.state.correlation_id,
                trace_id=request.state.trace_id,
                organization_id=principal.organization_id,
                active=False,
            )
        )
    except Exception as exc:
        _map_write_error(exc)
        raise
    return Response(status_code=status.HTTP_204_NO_CONTENT)
