"""Store-aware catalogue query use case."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from labelscan.contexts.traceability.application.catalog_ports import (
    CatalogFilter,
    CatalogRepository,
)
from labelscan.contexts.traceability.domain.catalog import (
    CatalogArrival,
    CatalogProduct,
)


class CatalogAccessDenied(Exception):
    """A user attempted to read another store's catalogue."""


class CatalogStoreRequired(Exception):
    """A store-scoped user has no store assignment."""


class CatalogArrivalNotFound(Exception):
    """The requested arrival is absent or not visible to the current store."""


@dataclass(frozen=True)
class CatalogAccess:
    store_code: str | None
    can_view_all_stores: bool = False
    organization_id: str = "test-organization"


@dataclass(frozen=True)
class CatalogQuery:
    access: CatalogAccess
    requested_store_code: str | None = None
    query: str | None = None
    date_from: date | None = None
    date_to: date | None = None
    limit: int = 50
    offset: int = 0


@dataclass(frozen=True)
class CatalogImageQuery:
    access: CatalogAccess
    batch_id: str


@dataclass(frozen=True)
class CatalogArrivalQuery:
    access: CatalogAccess
    batch_id: str


def _store_code(value: str | None) -> str | None:
    normalized = value.strip().upper() if value else ""
    return normalized or None


class CatalogService:
    def __init__(self, products: CatalogRepository) -> None:
        self._products = products

    def list(self, request: CatalogQuery) -> tuple[list[CatalogProduct], int]:
        actor_store = _store_code(request.access.store_code)
        requested_store = _store_code(request.requested_store_code)
        if request.access.can_view_all_stores:
            effective_store = requested_store
        else:
            if actor_store is None:
                raise CatalogStoreRequired()
            if requested_store is not None and requested_store != actor_store:
                raise CatalogAccessDenied()
            effective_store = actor_store

        if (
            request.date_from is not None
            and request.date_to is not None
            and request.date_from > request.date_to
        ):
            raise ValueError("date_from must be before or equal to date_to")
        if request.limit < 1 or request.limit > 200 or request.offset < 0:
            raise ValueError("invalid catalogue pagination")

        query = (
            request.query.strip() if request.query and request.query.strip() else None
        )
        return self._products.list_products(
            CatalogFilter(
                organization_id=request.access.organization_id,
                store_code=effective_store,
                query=query,
                date_from=request.date_from,
                date_to=request.date_to,
                limit=request.limit,
                offset=request.offset,
            )
        )

    def arrival(self, request: CatalogArrivalQuery) -> CatalogArrival:
        effective_store = _store_code(request.access.store_code)
        if not request.access.can_view_all_stores and effective_store is None:
            raise CatalogStoreRequired()
        arrival = self._products.get_arrival(
            request.access.organization_id,
            request.batch_id,
            None if request.access.can_view_all_stores else effective_store,
        )
        if arrival is None:
            raise CatalogArrivalNotFound()
        return arrival

    def image_checksum(self, request: CatalogImageQuery) -> str:
        effective_store = _store_code(request.access.store_code)
        if not request.access.can_view_all_stores and effective_store is None:
            raise CatalogStoreRequired()
        try:
            checksum = self._products.image_checksum(
                request.access.organization_id,
                request.batch_id,
                None if request.access.can_view_all_stores else effective_store,
            )
        except TypeError:
            # Compatibility with adapters deployed before the additive tenant arg.
            checksum = self._products.image_checksum(  # type: ignore[call-arg]
                request.batch_id,
                None if request.access.can_view_all_stores else effective_store,
            )
        if checksum is None:
            raise CatalogArrivalNotFound()
        return checksum
