"""Administrative use cases for the store directory."""

from __future__ import annotations

from dataclasses import dataclass

from labelscan.contexts.identity.application.store_ports import (
    NewStore,
    StoreAuditContext,
    StoreChanges,
    StoreRepository,
)
from labelscan.contexts.identity.domain.store import (
    Store,
    normalize_store_code,
    normalize_store_name,
)


@dataclass(frozen=True)
class CreateStoreCommand:
    code: str
    name: str
    actor_id: str
    correlation_id: str
    trace_id: str
    organization_id: str | None = None


@dataclass(frozen=True)
class UpdateStoreCommand:
    code: str
    actor_id: str
    correlation_id: str
    trace_id: str
    name: str | None = None
    active: bool | None = None
    organization_id: str | None = None


class StoreAdminService:
    def __init__(self, stores: StoreRepository) -> None:
        self._stores = stores

    def create(self, command: CreateStoreCommand) -> Store:
        return self._stores.create_store(
            NewStore(
                code=normalize_store_code(command.code),
                name=normalize_store_name(command.name),
                created_by=command.actor_id,
            ),
            StoreAuditContext(
                actor_id=command.actor_id,
                correlation_id=command.correlation_id,
                trace_id=command.trace_id,
                organization_id=command.organization_id,
            ),
        )

    def list(
        self,
        *,
        organization_id: str | None = None,
        active: bool | None,
        query: str | None,
    ) -> list[Store]:
        normalized_query = query.strip() if query and query.strip() else None
        return self._stores.list_stores(
            organization_id=organization_id,
            active=active,
            query=normalized_query,
        )

    def update(self, command: UpdateStoreCommand) -> Store:
        if command.name is None and command.active is None:
            raise ValueError("at least one store field must be provided")
        return self._stores.update_store(
            normalize_store_code(command.code),
            StoreChanges(
                name=(
                    normalize_store_name(command.name)
                    if command.name is not None
                    else None
                ),
                active=command.active,
            ),
            StoreAuditContext(
                actor_id=command.actor_id,
                correlation_id=command.correlation_id,
                trace_id=command.trace_id,
                organization_id=command.organization_id,
            ),
        )
