"""Role-specific identity administration."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from labelscan.contexts.identity.domain.password import hash_password, verify_password
from labelscan.contexts.identity.domain.user import (
    ADMIN_ROLE,
    MANAGER_ROLE,
    SUPER_ADMIN_ROLE,
    ManagedUser,
    normalize_identity_text,
)


class AccessDenied(Exception):
    pass


class IdentityNotFound(Exception):
    pass


class IdentityAlreadyExists(Exception):
    def __init__(self, scope: str = "organization") -> None:
        self.scope = scope
        super().__init__(scope)


class IdentityPasswordAlreadyExists(Exception):
    pass


class IdentityCredentialPairAlreadyExists(Exception):
    pass


class InvalidCurrentPassword(Exception):
    pass


@dataclass(frozen=True)
class IdentityAudit:
    actor_id: str
    organization_id: str
    correlation_id: str
    trace_id: str


@dataclass(frozen=True)
class AllowedStore:
    id: str
    code: str
    name: str
    active: bool


@dataclass(frozen=True)
class AllowedPortal:
    id: str
    store_id: str
    store_code: str
    store_name: str
    profession_code: str
    profession_name: str
    name: str
    active: bool


@dataclass(frozen=True)
class AccessOverview:
    user: ManagedUser
    scopes: tuple[str, ...]
    stores: tuple[AllowedStore, ...]
    business_portals: tuple[AllowedPortal, ...]


class AccessRepository(Protocol):
    def get_access_overview(self, audit: IdentityAudit) -> AccessOverview: ...

    def list_store_portals(
        self, audit: IdentityAudit, store_id: str
    ) -> tuple[AllowedPortal, ...]: ...

    def set_store_portal_active(
        self,
        audit: IdentityAudit,
        *,
        store_id: str,
        portal_id: str,
        active: bool,
    ) -> AllowedPortal: ...

    def list_role(self, audit: IdentityAudit, role: str) -> list[ManagedUser]: ...

    def create_active(
        self,
        audit: IdentityAudit,
        *,
        actor_roles: frozenset[str],
        username: str,
        display_name: str,
        role: str,
        portal_ids: tuple[str, ...],
        password: str,
        password_hash: str,
    ) -> ManagedUser: ...

    def replace_assignments(
        self,
        audit: IdentityAudit,
        *,
        target_user_id: str,
        target_role: str,
        portal_ids: tuple[str, ...],
        actor_roles: frozenset[str],
    ) -> ManagedUser: ...

    def set_active(
        self,
        audit: IdentityAudit,
        *,
        target_user_id: str,
        target_role: str,
        active: bool,
        actor_roles: frozenset[str],
    ) -> ManagedUser: ...

    def delete_manager(
        self,
        audit: IdentityAudit,
        *,
        target_user_id: str,
        actor_roles: frozenset[str],
    ) -> None: ...

    def own_credentials(self, audit: IdentityAudit) -> tuple[str, str]: ...

    def manager_password_in_use(
        self, audit: IdentityAudit, password: str
    ) -> bool: ...

    def change_own_password(
        self, audit: IdentityAudit, expected_password_hash: str, password_hash: str
    ) -> ManagedUser: ...


def _bounded_text(value: str, field: str, maximum: int) -> str:
    return normalize_identity_text(value, field=field, maximum=maximum)


def _password(value: str, *, role: str) -> str:
    if not value:
        raise ValueError("password must not be blank")
    if len(value) > 128:
        raise ValueError("password must be at most 128 characters")
    if role in {ADMIN_ROLE, SUPER_ADMIN_ROLE}:
        if len(value) < 12:
            raise ValueError("password must be at least 12 characters")
        if not any(character.isupper() for character in value):
            raise ValueError("password must contain an uppercase letter")
        if not any(character.islower() for character in value):
            raise ValueError("password must contain a lowercase letter")
        if not any(character.isdigit() for character in value):
            raise ValueError("password must contain a digit")
        if not any(not character.isalnum() for character in value):
            raise ValueError("password must contain a special character")
        return hash_password(value, min_length=12)
    if role == MANAGER_ROLE:
        return hash_password(value, min_length=1)
    raise ValueError("unknown password policy")


class AccessManagementService:
    def __init__(self, repository: AccessRepository) -> None:
        self._repository = repository

    def me(self, audit: IdentityAudit) -> AccessOverview:
        return self._repository.get_access_overview(audit)

    def list_store_portals(
        self, audit: IdentityAudit, store_id: str
    ) -> tuple[AllowedPortal, ...]:
        return self._repository.list_store_portals(audit, store_id)

    def set_store_portal_active(
        self,
        audit: IdentityAudit,
        *,
        store_id: str,
        portal_id: str,
        active: bool,
    ) -> AllowedPortal:
        return self._repository.set_store_portal_active(
            audit,
            store_id=store_id,
            portal_id=portal_id,
            active=active,
        )

    def list_role(self, audit: IdentityAudit, role: str) -> list[ManagedUser]:
        return self._repository.list_role(audit, role)

    def create_active(
        self,
        audit: IdentityAudit,
        *,
        actor_roles: frozenset[str],
        username: str,
        display_name: str | None,
        password: str,
        role: str,
        portal_ids: tuple[str, ...] = (),
    ) -> ManagedUser:
        password_hash = _password(password, role=role)
        return self._repository.create_active(
            audit,
            actor_roles=actor_roles,
            username=_bounded_text(username, "username", 254),
            # Display names are no longer part of the product UI.  Keep the
            # non-null legacy column populated with the canonical identifier.
            display_name=_bounded_text(
                display_name or username, "display_name", 120
            ),
            role=role,
            portal_ids=tuple(dict.fromkeys(portal_ids)),
            password=password,
            password_hash=password_hash,
        )

    def replace_assignments(
        self,
        audit: IdentityAudit,
        *,
        target_user_id: str,
        target_role: str,
        portal_ids: tuple[str, ...],
        actor_roles: frozenset[str],
    ) -> ManagedUser:
        return self._repository.replace_assignments(
            audit,
            target_user_id=target_user_id,
            target_role=target_role,
            portal_ids=tuple(dict.fromkeys(portal_ids)),
            actor_roles=actor_roles,
        )

    def set_active(
        self,
        audit: IdentityAudit,
        *,
        target_user_id: str,
        target_role: str,
        active: bool,
        actor_roles: frozenset[str],
    ) -> ManagedUser:
        return self._repository.set_active(
            audit,
            target_user_id=target_user_id,
            target_role=target_role,
            active=active,
            actor_roles=actor_roles,
        )

    def delete_manager(
        self,
        audit: IdentityAudit,
        *,
        target_user_id: str,
        actor_roles: frozenset[str],
    ) -> None:
        self._repository.delete_manager(
            audit,
            target_user_id=target_user_id,
            actor_roles=actor_roles,
        )

    def change_own_password(
        self, audit: IdentityAudit, current_password: str, new_password: str
    ) -> ManagedUser:
        role, current_hash = self._repository.own_credentials(audit)
        if not verify_password(current_password, current_hash):
            raise InvalidCurrentPassword()
        if role == MANAGER_ROLE and self._repository.manager_password_in_use(
            audit, new_password
        ):
            raise IdentityPasswordAlreadyExists()
        return self._repository.change_own_password(
            audit,
            current_hash,
            _password(new_password, role=role),
        )
