"""Administrator-only HTTP API for the store directory."""

from __future__ import annotations

import threading
import uuid

from fastapi import APIRouter, Depends, Query, Request, status
from pydantic import BaseModel, Field

from labelscan.contexts.identity.application.manage_stores import (
    CreateStoreCommand,
    StoreAdminService,
    UpdateStoreCommand,
)
from labelscan.contexts.identity.application.store_ports import (
    StoreAlreadyExists,
    StoreInUse,
    StoreNotFound,
)
from labelscan.contexts.identity.domain.store import Store
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.security import Principal, require_scope

router = APIRouter()

_SERVICE: StoreAdminService | None = None
_SERVICE_LOCK = threading.Lock()


def get_store_admin_service() -> StoreAdminService:
    global _SERVICE
    if _SERVICE is None:
        with _SERVICE_LOCK:
            if _SERVICE is None:
                from labelscan.contexts.identity.adapters.sql_store_repository import (
                    SqlStoreRepository,
                )
                from labelscan.platform.db.engine import make_engine

                _SERVICE = StoreAdminService(SqlStoreRepository(make_engine()))
    return _SERVICE


class StoreResponse(BaseModel):
    id: str
    code: str
    name: str
    active: bool
    created_by: str
    created_at: str
    updated_at: str
    organization_id: str | None = None

    @classmethod
    def from_domain(cls, store: Store) -> "StoreResponse":
        return cls(**store.__dict__)


class CreateStoreRequest(BaseModel):
    # The web portal creates opaque codes automatically.  Keeping this optional
    # preserves the API for integrations that already own a store-code scheme.
    code: str | None = Field(None, min_length=1)
    name: str = Field(min_length=1)


class UpdateStoreRequest(BaseModel):
    name: str | None = Field(None, min_length=1)
    active: bool | None = None


class CurrentStoreResponse(BaseModel):
    """The only store information an operator needs in the portal."""

    name: str


def _new_internal_store_code() -> str:
    """Generate an opaque, collision-resistant store identifier."""
    return f"STORE-{uuid.uuid4().hex.upper()}"


def _map_write_error(exc: Exception) -> None:
    if isinstance(exc, StoreAlreadyExists):
        raise ApiError("STORE_ALREADY_EXISTS", "store code is already in use")
    if isinstance(exc, StoreNotFound):
        raise ApiError("NOT_FOUND", "store not found")
    if isinstance(exc, StoreInUse):
        raise ApiError(
            "STORE_IN_USE",
            "store cannot be disabled while active users are assigned",
        )
    if isinstance(exc, ValueError):
        raise ApiError("VALIDATION_ERROR", str(exc))
    raise exc


@router.post(
    "/v1/stores",
    response_model=StoreResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_store(
    body: CreateStoreRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:admin")),
    service: StoreAdminService = Depends(get_store_admin_service),
) -> StoreResponse:
    try:
        store = service.create(
            CreateStoreCommand(
                code=body.code or _new_internal_store_code(),
                name=body.name,
                actor_id=principal.actor_id,
                correlation_id=request.state.correlation_id,
                trace_id=request.state.trace_id,
                organization_id=principal.organization_id,
            )
        )
    except Exception as exc:
        _map_write_error(exc)
        raise
    return StoreResponse.from_domain(store)


@router.get("/v1/stores", response_model=list[StoreResponse])
def list_stores(
    active: bool | None = Query(None),
    q: str | None = Query(None),
    principal: Principal = Depends(require_scope("identity:admin")),
    service: StoreAdminService = Depends(get_store_admin_service),
) -> list[StoreResponse]:
    stores = service.list(
        organization_id=principal.organization_id, active=active, query=q
    )
    return [StoreResponse.from_domain(store) for store in stores]


@router.get("/v1/stores/current", response_model=CurrentStoreResponse)
def get_current_store(
    principal: Principal = Depends(require_scope("catalog:read")),
    service: StoreAdminService = Depends(get_store_admin_service),
) -> CurrentStoreResponse:
    """Expose an operator's assigned store name without its internal code."""
    if not principal.store_code:
        raise ApiError("STORE_REQUIRED")

    stores = service.list(
        organization_id=principal.organization_id,
        active=None,
        query=principal.store_code,
    )
    store = next((item for item in stores if item.code == principal.store_code), None)
    if store is None:
        raise ApiError("NOT_FOUND", "assigned store not found")
    return CurrentStoreResponse(name=store.name)


@router.patch("/v1/stores/{code}", response_model=StoreResponse)
def update_store(
    code: str,
    body: UpdateStoreRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:admin")),
    service: StoreAdminService = Depends(get_store_admin_service),
) -> StoreResponse:
    try:
        store = service.update(
            UpdateStoreCommand(
                code=code,
                name=body.name,
                active=body.active,
                actor_id=principal.actor_id,
                correlation_id=request.state.correlation_id,
                trace_id=request.state.trace_id,
                organization_id=principal.organization_id,
            )
        )
    except Exception as exc:
        _map_write_error(exc)
        raise
    return StoreResponse.from_domain(store)
