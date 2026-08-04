"""Role-specific identity administration and one-time account activation."""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from labelscan.contexts.identity.domain.password import hash_password
from labelscan.contexts.identity.domain.user import ManagedUser


class AccessDenied(Exception):
    pass


class IdentityNotFound(Exception):
    pass


class IdentityAlreadyExists(Exception):
    pass


class InvalidActivation(Exception):
    pass


@dataclass(frozen=True)
class IdentityAudit:
    actor_id: str
    organization_id: str
    correlation_id: str
    trace_id: str


@dataclass(frozen=True)
class ActivationGrant:
    user: ManagedUser
    activation_token: str
    expires_at: str


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

    def list_role(
        self, audit: IdentityAudit, role: str, portal_id: str | None = None
    ) -> list[ManagedUser]: ...

    def create_pending(
        self,
        audit: IdentityAudit,
        *,
        actor_roles: frozenset[str],
        username: str,
        display_name: str,
        role: str,
        portal_ids: tuple[str, ...],
        placeholder_password_hash: str,
        activation_token_hash: str,
        expires_at: datetime,
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

    def issue_reset(
        self,
        audit: IdentityAudit,
        *,
        target_user_id: str,
        placeholder_password_hash: str,
        activation_token_hash: str,
        expires_at: datetime,
    ) -> ManagedUser: ...

    def activate(
        self,
        token_hash: str,
        password_hash: str,
        expected_role: str | None = None,
    ) -> ManagedUser: ...

    def change_own_password(
        self, audit: IdentityAudit, password_hash: str
    ) -> ManagedUser: ...


def _bounded_text(value: str, field: str, maximum: int) -> str:
    normalized = " ".join(value.split())
    if not normalized:
        raise ValueError(f"{field} must not be blank")
    if len(normalized) > maximum:
        raise ValueError(f"{field} must be at most {maximum} characters")
    return normalized


def _password(value: str) -> str:
    if len(value) < 12 or len(value) > 128:
        raise ValueError("password must contain between 12 and 128 characters")
    return hash_password(value)


def _token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class AccessManagementService:
    def __init__(self, repository: AccessRepository) -> None:
        self._repository = repository

    @staticmethod
    def _grant_token() -> tuple[str, str, datetime]:
        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(UTC) + timedelta(hours=24)
        return token, _token_digest(token), expires_at

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

    def list_role(
        self, audit: IdentityAudit, role: str, portal_id: str | None = None
    ) -> list[ManagedUser]:
        return self._repository.list_role(audit, role, portal_id)

    def create_pending(
        self,
        audit: IdentityAudit,
        *,
        actor_roles: frozenset[str],
        username: str,
        display_name: str,
        role: str,
        portal_ids: tuple[str, ...] = (),
    ) -> ActivationGrant:
        token, digest, expires_at = self._grant_token()
        user = self._repository.create_pending(
            audit,
            actor_roles=actor_roles,
            username=_bounded_text(username, "username", 254),
            display_name=_bounded_text(display_name, "display_name", 120),
            role=role,
            portal_ids=tuple(dict.fromkeys(portal_ids)),
            placeholder_password_hash=hash_password(secrets.token_urlsafe(48)),
            activation_token_hash=digest,
            expires_at=expires_at,
        )
        return ActivationGrant(user, token, expires_at.isoformat())

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

    def credential_reset(
        self, audit: IdentityAudit, target_user_id: str
    ) -> ActivationGrant:
        token, digest, expires_at = self._grant_token()
        user = self._repository.issue_reset(
            audit,
            target_user_id=target_user_id,
            placeholder_password_hash=hash_password(secrets.token_urlsafe(48)),
            activation_token_hash=digest,
            expires_at=expires_at,
        )
        return ActivationGrant(user, token, expires_at.isoformat())

    def activate(
        self,
        token: str,
        new_password: str,
        *,
        expected_role: str | None = None,
    ) -> ManagedUser:
        if not token:
            raise InvalidActivation()
        return self._repository.activate(
            _token_digest(token),
            _password(new_password),
            expected_role,
        )

    def change_own_password(
        self, audit: IdentityAudit, new_password: str
    ) -> ManagedUser:
        return self._repository.change_own_password(audit, _password(new_password))
