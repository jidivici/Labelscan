"""Role-specific IAM API. Generic user mutations are intentionally not used."""

from __future__ import annotations

import threading
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from labelscan.contexts.identity.application.access_management import (
    AccessDenied,
    AccessManagementService,
    AccessOverview,
    AllowedPortal,
    AllowedStore,
    IdentityAlreadyExists,
    IdentityAudit,
    IdentityNotFound,
    InvalidCurrentPassword,
)
from labelscan.contexts.identity.domain.user import (
    ADMIN_ROLE,
    MANAGER_ROLE,
    SUPER_ADMIN_ROLE,
    ManagedUser,
)
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.security import Principal, require_scope, resolve_principal

router = APIRouter()
_SERVICE: AccessManagementService | None = None
_LOCK = threading.Lock()


def get_access_management_service() -> AccessManagementService:
    global _SERVICE
    if _SERVICE is None:
        with _LOCK:
            if _SERVICE is None:
                from labelscan.contexts.identity.adapters.sql_access_repository import (
                    SqlAccessRepository,
                )
                from labelscan.platform.db.engine import make_engine

                _SERVICE = AccessManagementService(SqlAccessRepository(make_engine()))
    return _SERVICE


class UserResponse(BaseModel):
    id: str
    username: str
    display_name: str
    role: str
    active: bool
    organization_id: str | None
    store_id: str | None
    store_code: str | None
    business_portal_ids: list[str]
    created_by: str
    created_at: str
    updated_at: str

    @classmethod
    def from_domain(cls, user: ManagedUser) -> "UserResponse":
        return cls(
            **{
                **user.__dict__,
                "business_portal_ids": list(user.business_portal_ids),
            }
        )


class StoreResponse(BaseModel):
    id: str
    code: str
    name: str
    active: bool

    @classmethod
    def from_domain(cls, store: AllowedStore) -> "StoreResponse":
        return cls(**store.__dict__)


class PortalResponse(BaseModel):
    id: str
    store_id: str
    store_code: str
    store_name: str
    profession_code: str
    profession_name: str
    name: str
    active: bool

    @classmethod
    def from_domain(cls, portal: AllowedPortal) -> "PortalResponse":
        return cls(**portal.__dict__)


class MeResponse(BaseModel):
    user: UserResponse
    capabilities: list[str] = Field(
        description="Canonical capabilities granted by the persisted user role."
    )
    scopes: list[str] = Field(
        description="OAuth-style scope names; currently identical to capabilities."
    )
    stores: list[StoreResponse] = Field(
        description="Stores visible to the current role and portal assignments."
    )
    business_portals: list[PortalResponse] = Field(
        description="Business portals visible to the current role and assignments."
    )

    @classmethod
    def from_domain(cls, overview: AccessOverview) -> "MeResponse":
        scopes = list(overview.scopes)
        return cls(
            user=UserResponse.from_domain(overview.user),
            capabilities=scopes,
            scopes=scopes,
            stores=[StoreResponse.from_domain(store) for store in overview.stores],
            business_portals=[
                PortalResponse.from_domain(portal)
                for portal in overview.business_portals
            ],
        )


class _StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateIdentityRequest(_StrictRequest):
    username: str = Field(min_length=1, max_length=254)
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    password: str = Field(min_length=12, max_length=128)


class CreateManagerRequest(CreateIdentityRequest):
    business_portal_ids: list[UUID] = Field(min_length=1, max_length=1)


class ManagerAssignmentsRequest(_StrictRequest):
    business_portal_ids: list[UUID] = Field(min_length=1, max_length=1)


class ActiveRequest(_StrictRequest):
    active: bool


class ChangePasswordRequest(_StrictRequest):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=12, max_length=128)


class SetPortalActiveRequest(_StrictRequest):
    portal_id: UUID = Field(
        description="Portal belonging to the store identified by the URL."
    )
    active: bool = Field(
        description="Desired soft-activation state. Repeating the same PUT is a no-op."
    )


def _audit(request: Request, principal: Principal) -> IdentityAudit:
    if not principal.organization_id:
        raise ApiError("UNAUTHENTICATED", "organization context is missing")
    return IdentityAudit(
        actor_id=principal.actor_id,
        organization_id=principal.organization_id,
        correlation_id=request.state.correlation_id,
        trace_id=request.state.trace_id,
    )


def _map_error(exc: Exception) -> None:
    if isinstance(exc, AccessDenied):
        raise ApiError(
            "FORBIDDEN", "cette opération dépasse vos droits ou votre périmètre"
        )
    if isinstance(exc, IdentityNotFound):
        raise ApiError("NOT_FOUND", "compte ou portail introuvable")
    if isinstance(exc, IdentityAlreadyExists):
        raise ApiError("USER_ALREADY_EXISTS", "cet identifiant est déjà utilisé")
    if isinstance(exc, InvalidCurrentPassword):
        raise ApiError(
            "INVALID_CURRENT_PASSWORD", "le mot de passe actuel est incorrect"
        )
    if isinstance(exc, ValueError):
        raise ApiError("VALIDATION_ERROR", str(exc))
    raise exc


@router.get(
    "/v1/me",
    response_model=MeResponse,
    summary="Get the current user and complete access context",
    description=(
        "Returns role-derived capabilities plus authorized stores and detailed business "
        "portals. Super-administrators see the organization, administrators see their "
        "owned store portals, and managers are limited to their active assignment."
    ),
)
def get_me(
    request: Request,
    principal: Principal = Depends(resolve_principal),
    service: AccessManagementService = Depends(get_access_management_service),
) -> MeResponse:
    try:
        return MeResponse.from_domain(service.me(_audit(request, principal)))
    except Exception as exc:
        _map_error(exc)
        raise


@router.get(
    "/v1/stores/{store_id}/portals",
    response_model=list[PortalResponse],
    summary="List the business portals visible for a store",
    description=(
        "Super-administrators see every portal of an organization-owned store. "
        "Administrators see portals of stores they own; managers see only their active "
        "assignment. An invisible or foreign store is reported as not found."
    ),
)
def list_store_portals(
    store_id: UUID,
    request: Request,
    principal: Principal = Depends(resolve_principal),
    service: AccessManagementService = Depends(get_access_management_service),
) -> list[PortalResponse]:
    try:
        portals = service.list_store_portals(_audit(request, principal), str(store_id))
        return [PortalResponse.from_domain(portal) for portal in portals]
    except Exception as exc:
        _map_error(exc)
        raise


@router.put(
    "/v1/stores/{store_id}/portals",
    response_model=PortalResponse,
    summary="Soft-activate or deactivate a store portal",
    description=(
        "Admin and super-admin only. The requested state is idempotent and never deletes "
        "a portal. A real state transition is audited atomically; deactivation revokes "
        "sessions belonging to users assigned to that portal."
    ),
)
def set_store_portal_active(
    store_id: UUID,
    body: SetPortalActiveRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:portals:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> PortalResponse:
    try:
        portal = service.set_store_portal_active(
            _audit(request, principal),
            store_id=str(store_id),
            portal_id=str(body.portal_id),
            active=body.active,
        )
        return PortalResponse.from_domain(portal)
    except Exception as exc:
        _map_error(exc)
        raise


@router.post("/v1/me/password", response_model=UserResponse)
def change_my_password(
    body: ChangePasswordRequest,
    request: Request,
    principal: Principal = Depends(resolve_principal),
    service: AccessManagementService = Depends(get_access_management_service),
) -> UserResponse:
    try:
        return UserResponse.from_domain(
            service.change_own_password(
                _audit(request, principal),
                body.current_password,
                body.new_password,
            )
        )
    except Exception as exc:
        _map_error(exc)
        raise


@router.get("/v1/admins", response_model=list[UserResponse])
def list_admins(
    request: Request,
    principal: Principal = Depends(require_scope("identity:admins:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> list[UserResponse]:
    try:
        users = service.list_role(_audit(request, principal), ADMIN_ROLE)
        return [UserResponse.from_domain(user) for user in users]
    except Exception as exc:
        _map_error(exc)
        raise


@router.post(
    "/v1/admins",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_admin(
    body: CreateIdentityRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:admins:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> UserResponse:
    try:
        return UserResponse.from_domain(
            service.create_active(
                _audit(request, principal),
                actor_roles=frozenset({SUPER_ADMIN_ROLE}),
                username=body.username,
                display_name=body.display_name,
                password=body.password,
                role=ADMIN_ROLE,
            )
        )
    except Exception as exc:
        _map_error(exc)
        raise


@router.delete("/v1/admins/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_admin(
    user_id: UUID,
    request: Request,
    principal: Principal = Depends(require_scope("identity:admins:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> Response:
    try:
        service.set_active(
            _audit(request, principal),
            target_user_id=str(user_id),
            target_role=ADMIN_ROLE,
            active=False,
            actor_roles=frozenset({SUPER_ADMIN_ROLE}),
        )
    except Exception as exc:
        _map_error(exc)
        raise
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/v1/managers", response_model=list[UserResponse])
def list_managers(
    request: Request,
    principal: Principal = Depends(require_scope("identity:managers:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> list[UserResponse]:
    try:
        users = service.list_role(_audit(request, principal), MANAGER_ROLE)
        return [UserResponse.from_domain(user) for user in users]
    except Exception as exc:
        _map_error(exc)
        raise


@router.post(
    "/v1/managers",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_manager(
    body: CreateManagerRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:managers:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> UserResponse:
    try:
        portal_ids = tuple(str(value) for value in body.business_portal_ids)
        return UserResponse.from_domain(
            service.create_active(
                _audit(request, principal),
                actor_roles=frozenset({SUPER_ADMIN_ROLE, ADMIN_ROLE}),
                username=body.username,
                display_name=body.display_name,
                password=body.password,
                role=MANAGER_ROLE,
                portal_ids=portal_ids,
            )
        )
    except Exception as exc:
        _map_error(exc)
        raise


@router.patch("/v1/managers/{user_id}/portals", response_model=UserResponse)
def change_manager_portals(
    user_id: UUID,
    body: ManagerAssignmentsRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:managers:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> UserResponse:
    try:
        user = service.replace_assignments(
            _audit(request, principal),
            target_user_id=str(user_id),
            target_role=MANAGER_ROLE,
            portal_ids=tuple(str(value) for value in body.business_portal_ids),
            actor_roles=frozenset({SUPER_ADMIN_ROLE, ADMIN_ROLE}),
        )
        return UserResponse.from_domain(user)
    except Exception as exc:
        _map_error(exc)
        raise


@router.patch("/v1/managers/{user_id}", response_model=UserResponse)
def set_manager_active(
    user_id: UUID,
    body: ActiveRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:managers:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> UserResponse:
    try:
        user = service.set_active(
            _audit(request, principal),
            target_user_id=str(user_id),
            target_role=MANAGER_ROLE,
            active=body.active,
            actor_roles=frozenset({SUPER_ADMIN_ROLE, ADMIN_ROLE}),
        )
        return UserResponse.from_domain(user)
    except Exception as exc:
        _map_error(exc)
        raise


@router.delete(
    "/v1/managers/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a manager from active administration",
    description=(
        "Soft-deletes the account and revokes its access while preserving the "
        "identity row used by historical labels. The username becomes reusable."
    ),
)
def delete_manager(
    user_id: UUID,
    request: Request,
    principal: Principal = Depends(require_scope("identity:managers:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> Response:
    try:
        service.delete_manager(
            _audit(request, principal),
            target_user_id=str(user_id),
            actor_roles=frozenset({SUPER_ADMIN_ROLE, ADMIN_ROLE}),
        )
    except Exception as exc:
        _map_error(exc)
        raise
    return Response(status_code=status.HTTP_204_NO_CONTENT)
