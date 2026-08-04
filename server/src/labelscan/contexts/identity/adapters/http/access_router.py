"""Role-specific IAM API. Generic user mutations are intentionally not used."""

from __future__ import annotations

import threading
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, Field

from labelscan.contexts.identity.application.access_management import (
    AccessDenied,
    AccessManagementService,
    AccessOverview,
    ActivationGrant,
    AllowedPortal,
    AllowedStore,
    IdentityAlreadyExists,
    IdentityAudit,
    IdentityNotFound,
    InvalidActivation,
)
from labelscan.contexts.identity.domain.user import (
    ADMIN_ROLE,
    MANAGER_ROLE,
    OPERATOR_ROLE,
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


class ActivationResponse(BaseModel):
    user: UserResponse
    activation_token: str
    expires_at: str

    @classmethod
    def from_domain(cls, grant: ActivationGrant) -> "ActivationResponse":
        return cls(
            user=UserResponse.from_domain(grant.user),
            activation_token=grant.activation_token,
            expires_at=grant.expires_at,
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


class CreateIdentityRequest(BaseModel):
    username: str = Field(min_length=1, max_length=254)
    display_name: str = Field(min_length=1, max_length=120)


class CreateManagerRequest(CreateIdentityRequest):
    business_portal_ids: list[UUID] = Field(min_length=1)


class ManagerAssignmentsRequest(BaseModel):
    business_portal_ids: list[UUID] = Field(min_length=1)


class ActiveRequest(BaseModel):
    active: bool


class OperatorUpdateRequest(BaseModel):
    business_portal_id: UUID | None = None
    active: bool | None = None


class ActivateRequest(BaseModel):
    token: str = Field(min_length=32, max_length=256)
    new_password: str = Field(min_length=12, max_length=128)


class ChangePasswordRequest(BaseModel):
    new_password: str = Field(min_length=12, max_length=128)


class SetPortalActiveRequest(BaseModel):
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
        raise ApiError("FORBIDDEN", "identity operation is outside your role or portal")
    if isinstance(exc, IdentityNotFound):
        raise ApiError("NOT_FOUND", "identity or portal not found")
    if isinstance(exc, IdentityAlreadyExists):
        raise ApiError("USER_ALREADY_EXISTS", "username is already in use")
    if isinstance(exc, InvalidActivation):
        raise ApiError("UNAUTHENTICATED", "activation token is invalid or expired")
    if isinstance(exc, ValueError):
        raise ApiError("VALIDATION_ERROR", str(exc))
    raise exc


@router.post("/v1/auth/activate", response_model=UserResponse)
def activate_account(
    body: ActivateRequest,
    service: AccessManagementService = Depends(get_access_management_service),
) -> UserResponse:
    try:
        return UserResponse.from_domain(service.activate(body.token, body.new_password))
    except Exception as exc:
        _map_error(exc)
        raise


@router.post(
    "/v1/mobile/auth/activate",
    response_model=UserResponse,
    summary="Activate an operator account from the mobile application",
)
def activate_operator_account(
    body: ActivateRequest,
    service: AccessManagementService = Depends(get_access_management_service),
) -> UserResponse:
    try:
        return UserResponse.from_domain(
            service.activate(
                body.token,
                body.new_password,
                expected_role=OPERATOR_ROLE,
            )
        )
    except Exception as exc:
        _map_error(exc)
        raise


@router.get(
    "/v1/me",
    response_model=MeResponse,
    summary="Get the current user and complete access context",
    description=(
        "Returns role-derived capabilities plus authorized stores and detailed business "
        "portals. Administrators see the whole organization; managers and operators are "
        "limited to their active portal assignments."
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
        "Administrators see every portal of an organization-owned store. Managers and "
        "operators see only active portals assigned to them; an unassigned or foreign "
        "store is reported as not found."
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
            service.change_own_password(_audit(request, principal), body.new_password)
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
    "/v1/admins", response_model=ActivationResponse, status_code=status.HTTP_201_CREATED
)
def create_admin(
    body: CreateIdentityRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:admins:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> ActivationResponse:
    try:
        grant = service.create_pending(
            _audit(request, principal),
            actor_roles=frozenset({SUPER_ADMIN_ROLE}),
            username=body.username,
            display_name=body.display_name,
            role=ADMIN_ROLE,
        )
        return ActivationResponse.from_domain(grant)
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
    response_model=ActivationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_manager(
    body: CreateManagerRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:managers:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> ActivationResponse:
    try:
        grant = service.create_pending(
            _audit(request, principal),
            actor_roles=frozenset({SUPER_ADMIN_ROLE, ADMIN_ROLE}),
            username=body.username,
            display_name=body.display_name,
            role=MANAGER_ROLE,
            portal_ids=tuple(str(value) for value in body.business_portal_ids),
        )
        return ActivationResponse.from_domain(grant)
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


@router.get("/v1/portals/{portal_id}/operators", response_model=list[UserResponse])
def list_operators(
    portal_id: UUID,
    request: Request,
    principal: Principal = Depends(require_scope("identity:operators:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> list[UserResponse]:
    try:
        users = service.list_role(
            _audit(request, principal), OPERATOR_ROLE, str(portal_id)
        )
        return [UserResponse.from_domain(user) for user in users]
    except Exception as exc:
        _map_error(exc)
        raise


@router.post(
    "/v1/portals/{portal_id}/operators",
    response_model=ActivationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_operator(
    portal_id: UUID,
    body: CreateIdentityRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:operators:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> ActivationResponse:
    try:
        grant = service.create_pending(
            _audit(request, principal),
            actor_roles=frozenset({MANAGER_ROLE}),
            username=body.username,
            display_name=body.display_name,
            role=OPERATOR_ROLE,
            portal_ids=(str(portal_id),),
        )
        return ActivationResponse.from_domain(grant)
    except Exception as exc:
        _map_error(exc)
        raise


@router.patch(
    "/v1/portals/{portal_id}/operators/{user_id}", response_model=UserResponse
)
def update_operator(
    portal_id: UUID,
    user_id: UUID,
    body: OperatorUpdateRequest,
    request: Request,
    principal: Principal = Depends(require_scope("identity:operators:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> UserResponse:
    try:
        audit = _audit(request, principal)
        user = service.list_role(audit, OPERATOR_ROLE, str(portal_id))
        if str(user_id) not in {item.id for item in user}:
            raise IdentityNotFound()
        result = next(item for item in user if item.id == str(user_id))
        if body.business_portal_id is not None:
            result = service.replace_assignments(
                audit,
                target_user_id=str(user_id),
                target_role=OPERATOR_ROLE,
                portal_ids=(str(body.business_portal_id),),
                actor_roles=frozenset({MANAGER_ROLE}),
            )
        if body.active is not None:
            result = service.set_active(
                audit,
                target_user_id=str(user_id),
                target_role=OPERATOR_ROLE,
                active=body.active,
                actor_roles=frozenset({MANAGER_ROLE}),
            )
        return UserResponse.from_domain(result)
    except Exception as exc:
        _map_error(exc)
        raise


@router.post(
    "/v1/operators/{user_id}/credential-reset", response_model=ActivationResponse
)
def reset_operator_credential(
    user_id: UUID,
    request: Request,
    principal: Principal = Depends(require_scope("identity:operators:manage")),
    service: AccessManagementService = Depends(get_access_management_service),
) -> ActivationResponse:
    try:
        return ActivationResponse.from_domain(
            service.credential_reset(_audit(request, principal), str(user_id))
        )
    except Exception as exc:
        _map_error(exc)
        raise
