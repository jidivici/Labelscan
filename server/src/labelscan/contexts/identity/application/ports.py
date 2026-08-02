"""Application ports for the identity context (no frameworks/DB here)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from labelscan.contexts.identity.domain.user import ManagedUser, StoredUser


class UsernameAlreadyExists(Exception):
    """The requested username is already assigned to another account."""


class UserNotFound(Exception):
    """The requested account does not exist."""


class LastActiveAdmin(Exception):
    """A mutation would leave the installation without an active administrator."""


class SelfAccessChangeNotAllowed(Exception):
    """An administrator tried to revoke their own administration access."""


@dataclass(frozen=True)
class AdminAuditContext:
    actor_id: str
    correlation_id: str
    trace_id: str
    organization_id: str | None = None


@dataclass(frozen=True)
class NewUser:
    username: str
    display_name: str
    password_hash: str
    role: str
    store_code: str | None
    created_by: str


@dataclass(frozen=True)
class UserChanges:
    display_name: str | None = None
    password_hash: str | None = None
    role: str | None = None
    active: bool | None = None
    store_code: str | None = None


class UserRepository(Protocol):
    def find_active_by_username(
        self, username: str, organization_slug: str = "labelscan"
    ) -> StoredUser | None:
        """Return the active credential record for ``username``, or None."""
        ...

    def create_user(
        self, user: NewUser, audit: AdminAuditContext
    ) -> ManagedUser:
        """Create and audit an account atomically."""
        ...

    def list_users(
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
        """Return one filtered page and the total number of matching accounts."""
        ...

    def update_user(
        self,
        user_id: str,
        changes: UserChanges,
        audit: AdminAuditContext,
    ) -> ManagedUser:
        """Apply and audit a partial update atomically."""
        ...
