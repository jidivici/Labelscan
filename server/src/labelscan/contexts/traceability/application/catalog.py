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
from labelscan.platform.http.access import AccessContext


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
    context: AccessContext | None = None


@dataclass(frozen=True)
class CatalogQuery:
    access: CatalogAccess
    requested_store_code: str | None = None
    query: str | None = None
    date_from: date | None = None
    date_to: date | None = None
    limit: int = 50
    offset: int = 0
    requested_store_codes: tuple[str, ...] = ()
    requested_business_portal_id: str | None = None
    profession_code: str | None = None
    status: str | None = None
    alert_state: str | None = None
    completeness_min: int | None = None
    supplier: str | None = None
    lot_code: str | None = None
    gtin: str | None = None
    captured_by_user_id: str | None = None
    expiry_from: date | None = None
    expiry_to: date | None = None
    field_filters: tuple[tuple[str, str], ...] = ()
    sort_by: str = "recorded_at"
    sort_direction: str = "desc"


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
        requested_stores = tuple(
            dict.fromkeys(
                value
                for value in (
                    _store_code(request.requested_store_code),
                    *(_store_code(value) for value in request.requested_store_codes),
                )
                if value is not None
            )
        )
        context = request.access.context
        has_dimension_scope = bool(
            context and (context.business_portal_ids or context.store_ids)
        )
        if request.access.can_view_all_stores or has_dimension_scope:
            effective_stores = requested_stores
        else:
            if actor_store is None:
                raise CatalogStoreRequired()
            if any(store != actor_store for store in requested_stores):
                raise CatalogAccessDenied()
            effective_stores = (actor_store,)

        requested_portal = request.requested_business_portal_id
        if (
            requested_portal
            and context is not None
            and not context.organization_wide
            and requested_portal not in context.business_portal_ids
        ):
            raise CatalogAccessDenied()

        if (
            request.date_from is not None
            and request.date_to is not None
            and request.date_from > request.date_to
        ):
            raise ValueError("date_from must be before or equal to date_to")
        if request.limit < 1 or request.limit > 200 or request.offset < 0:
            raise ValueError("invalid catalogue pagination")
        if request.completeness_min is not None and not (
            0 <= request.completeness_min <= 100
        ):
            raise ValueError("completeness_min must be between 0 and 100")
        if request.sort_by not in {
            "recorded_at",
            "expiry_date",
            "product_name",
            "supplier",
            "lot_code",
            "completeness",
            "status",
        }:
            raise ValueError("unsupported catalogue sort")
        sort_direction = request.sort_direction.lower()
        if sort_direction not in {"asc", "desc"}:
            raise ValueError("sort_direction must be asc or desc")

        query = (
            request.query.strip() if request.query and request.query.strip() else None
        )
        return self._products.list_products(
            CatalogFilter(
                organization_id=request.access.organization_id,
                store_code=(
                    effective_stores[0] if len(effective_stores) == 1 else None
                ),
                query=query,
                date_from=request.date_from,
                date_to=request.date_to,
                limit=request.limit,
                offset=request.offset,
                access=context,
                store_codes=effective_stores,
                business_portal_id=requested_portal,
                profession_code=request.profession_code,
                status=request.status,
                alert_state=request.alert_state,
                completeness_min=request.completeness_min,
                supplier=request.supplier,
                lot_code=request.lot_code,
                gtin=request.gtin,
                captured_by_user_id=request.captured_by_user_id,
                expiry_from=request.expiry_from,
                expiry_to=request.expiry_to,
                field_filters=request.field_filters,
                sort_by=request.sort_by,
                sort_direction=sort_direction,
            )
        )

    def arrival(self, request: CatalogArrivalQuery) -> CatalogArrival:
        effective_store = _store_code(request.access.store_code)
        context = request.access.context
        has_dimension_scope = bool(
            context and (context.business_portal_ids or context.store_ids)
        )
        if (
            not request.access.can_view_all_stores
            and not has_dimension_scope
            and effective_store is None
        ):
            raise CatalogStoreRequired()
        store = (
            None
            if request.access.can_view_all_stores or has_dimension_scope
            else effective_store
        )
        try:
            arrival = self._products.get_arrival(
                request.access.organization_id,
                request.batch_id,
                store,
                request.access.context,
            )
        except TypeError:
            arrival = self._products.get_arrival(  # type: ignore[call-arg]
                request.access.organization_id,
                request.batch_id,
                store,
            )
        if arrival is None:
            raise CatalogArrivalNotFound()
        return arrival

    def image_checksum(self, request: CatalogImageQuery) -> str:
        effective_store = _store_code(request.access.store_code)
        context = request.access.context
        has_dimension_scope = bool(
            context and (context.business_portal_ids or context.store_ids)
        )
        if (
            not request.access.can_view_all_stores
            and not has_dimension_scope
            and effective_store is None
        ):
            raise CatalogStoreRequired()
        store = (
            None
            if request.access.can_view_all_stores or has_dimension_scope
            else effective_store
        )
        try:
            checksum = self._products.image_checksum(
                request.access.organization_id,
                request.batch_id,
                store,
                request.access.context,
            )
        except TypeError:
            try:
                checksum = self._products.image_checksum(  # type: ignore[call-arg]
                    request.access.organization_id,
                    request.batch_id,
                    store,
                )
            except TypeError:
                # Compatibility with test doubles that predate tenant arguments.
                checksum = self._products.image_checksum(  # type: ignore[call-arg]
                    request.batch_id,
                    store,
                )
        if checksum is None:
            raise CatalogArrivalNotFound()
        return checksum
