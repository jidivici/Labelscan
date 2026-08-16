"""Application port for the store-scoped catalogue."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Protocol

from labelscan.contexts.traceability.domain.catalog import (
    CatalogArrival,
    CatalogProduct,
)
from labelscan.platform.http.access import AccessContext


@dataclass(frozen=True)
class CatalogFilter:
    organization_id: str
    store_code: str | None
    query: str | None
    date_from: date | None
    date_to: date | None
    limit: int
    offset: int
    access: AccessContext | None = None
    store_codes: tuple[str, ...] = ()
    business_portal_id: str | None = None
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


class CatalogRepository(Protocol):
    def list_products(self, filters: CatalogFilter) -> tuple[list[CatalogProduct], int]:
        """Return one catalogue page and the total matching occurrences."""
        ...

    def get_arrival(
        self,
        organization_id: str,
        batch_id: str,
        store_code: str | None,
        access: AccessContext | None = None,
    ) -> CatalogArrival | None:
        """Return the complete latest arrival sheet when visible."""
        ...

    def image_checksum(
        self,
        organization_id: str,
        batch_id: str,
        store_code: str | None,
        access: AccessContext | None = None,
    ) -> str | None:
        """Return the source image checksum when the batch is visible."""
        ...
