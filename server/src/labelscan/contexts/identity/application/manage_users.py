"""Administrative user-management use cases.

Transport validation belongs to the HTTP adapter; this service keeps the
security-sensitive invariants transport-independent: role allow-listing,
password hashing, normalized identity fields, and atomic audited persistence.
"""

from __future__ import annotations

from dataclasses import dataclass

from labelscan.contexts.identity.application.ports import (
    AdminAuditContext,
    NewUser,
    UserChanges,
    UserRepository,
)
from labelscan.contexts.identity.application.store_ports import StoreRequired
from labelscan.contexts.identity.domain.password import hash_password
from labelscan.contexts.identity.domain.store import normalize_store_code
from labelscan.contexts.identity.domain.user import USER_ROLES, ManagedUser


def _username(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError("username must not be blank")
    if len(normalized) > 254:
        raise ValueError("username must be at most 254 characters")
    return normalized


def _display_name(value: str) -> str:
    normalized = " ".join(value.split())
    if not normalized:
        raise ValueError("display_name must not be blank")
    if len(normalized) > 120:
        raise ValueError("display_name must be at most 120 characters")
    return normalized


def _role(value: str) -> str:
    if value not in USER_ROLES:
        raise ValueError(f"unknown role '{value}'")
    return value


def _password_hash(password: str) -> str:
    return hash_password(password, min_length=1, reject_known_placeholder=False)


def _store_code(value: str | None) -> str | None:
    if value is None:
        return None
    return normalize_store_code(value)


@dataclass(frozen=True)
class CreateUserCommand:
    username: str
    display_name: str
    password: str
    role: str
    store_code: str | None
    actor_id: str
    correlation_id: str
    trace_id: str
    organization_id: str | None = None


@dataclass(frozen=True)
class UpdateUserCommand:
    user_id: str
    actor_id: str
    correlation_id: str
    trace_id: str
    display_name: str | None = None
    password: str | None = None
    role: str | None = None
    active: bool | None = None
    store_code: str | None = None
    organization_id: str | None = None


class UserAdminService:
    def __init__(self, users: UserRepository) -> None:
        self._users = users

    def create(self, command: CreateUserCommand) -> ManagedUser:
        role = _role(command.role)
        store_code = _store_code(command.store_code)
        if role == "manager" and store_code is None:
            raise StoreRequired()
        audit = AdminAuditContext(
            actor_id=command.actor_id,
            correlation_id=command.correlation_id,
            trace_id=command.trace_id,
            organization_id=command.organization_id,
        )
        return self._users.create_user(
            NewUser(
                username=_username(command.username),
                display_name=_display_name(command.display_name),
                password_hash=_password_hash(command.password),
                role=role,
                store_code=store_code,
                created_by=command.actor_id,
            ),
            audit,
        )

    def list(
        self,
        *,
        organization_id: str | None = None,
        role: str | None,
        active: bool | None,
        store_code: str | None,
        query: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[ManagedUser], int]:
        normalized_role = _role(role) if role is not None else None
        normalized_query = query.strip() if query and query.strip() else None
        return self._users.list_users(
            organization_id=organization_id,
            role=normalized_role,
            active=active,
            store_code=_store_code(store_code),
            query=normalized_query,
            limit=limit,
            offset=offset,
        )

    def update(self, command: UpdateUserCommand) -> ManagedUser:
        if (
            command.display_name is None
            and command.password is None
            and command.role is None
            and command.active is None
            and command.store_code is None
        ):
            raise ValueError("at least one user field must be provided")

        changes = UserChanges(
            display_name=(
                _display_name(command.display_name)
                if command.display_name is not None
                else None
            ),
            password_hash=(
                _password_hash(command.password)
                if command.password is not None
                else None
            ),
            role=_role(command.role) if command.role is not None else None,
            active=command.active,
            store_code=_store_code(command.store_code),
        )
        audit = AdminAuditContext(
            actor_id=command.actor_id,
            correlation_id=command.correlation_id,
            trace_id=command.trace_id,
            organization_id=command.organization_id,
        )
        return self._users.update_user(command.user_id, changes, audit)
