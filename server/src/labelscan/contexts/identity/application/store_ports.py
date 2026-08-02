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


class StoreRequired(Exception):
    """An operator account has no store assignment."""


@dataclass(frozen=True)
class StoreAuditContext:
    actor_id: str
    correlation_id: str
    trace_id: str
    organization_id: str | None = None


@dataclass(frozen=True)
class NewStore:
    code: str
    name: str
    created_by: str


@dataclass(frozen=True)
class StoreChanges:
    name: str | None = None
    active: bool | None = None


class StoreRepository(Protocol):
    def create_store(
        self, store: NewStore, audit: StoreAuditContext
    ) -> Store:
        ...

    def list_stores(
        self,
        *,
        organization_id: str | None = None,
        active: bool | None,
        query: str | None,
    ) -> list[Store]:
        ...

    def update_store(
        self,
        code: str,
        changes: StoreChanges,
        audit: StoreAuditContext,
    ) -> Store:
        ...
