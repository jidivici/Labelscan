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
    profession_codes: tuple[str, ...]
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
    manage_all_stores: bool = False


class StoreAdminService:
    def __init__(self, stores: StoreRepository) -> None:
        self._stores = stores

    def create(self, command: CreateStoreCommand) -> Store:
        profession_codes = tuple(
            dict.fromkeys(code.strip().lower() for code in command.profession_codes)
        )
        if not profession_codes:
            raise ValueError("at least one profession must be selected")
        return self._stores.create_store(
            NewStore(
                code=normalize_store_code(command.code),
                name=normalize_store_name(command.name),
                profession_codes=profession_codes,
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
        actor_id: str | None = None,
        include_all: bool = False,
    ) -> list[Store]:
        normalized_query = query.strip() if query and query.strip() else None
        return self._stores.list_stores(
            organization_id=organization_id,
            active=active,
            query=normalized_query,
            actor_id=actor_id,
            include_all=include_all,
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
                manage_all_stores=command.manage_all_stores,
            ),
        )
