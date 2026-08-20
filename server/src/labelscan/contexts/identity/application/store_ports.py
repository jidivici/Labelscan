"""Application ports for the store directory."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from labelscan.contexts.identity.domain.store import Store


class StoreAlreadyExists(Exception):
    """The requested store code already exists."""


class StoreNotFound(Exception):
    """The requested store does not exist."""


class StoreInUse(Exception):
    """The store still has active assigned users."""


class StoreInactive(Exception):
    """The store exists but cannot receive new assignments."""


@dataclass(frozen=True)
class StoreAuditContext:
    actor_id: str
    correlation_id: str
    trace_id: str
    organization_id: str | None = None
    manage_all_stores: bool = False


@dataclass(frozen=True)
class NewStore:
    code: str
    name: str
    profession_codes: tuple[str, ...]
    created_by: str


@dataclass(frozen=True)
class StoreChanges:
    name: str | None = None
    active: bool | None = None


class StoreRepository(Protocol):
    def create_store(self, store: NewStore, audit: StoreAuditContext) -> Store: ...

    def list_stores(
        self,
        *,
        organization_id: str | None = None,
        active: bool | None,
        query: str | None,
        actor_id: str | None = None,
        include_all: bool = False,
    ) -> list[Store]: ...

    def update_store(
        self,
        code: str,
        changes: StoreChanges,
        audit: StoreAuditContext,
    ) -> Store: ...
