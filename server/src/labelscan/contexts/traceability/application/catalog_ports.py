"""Application port for the store-scoped catalogue."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Protocol

from labelscan.contexts.traceability.domain.catalog import (
    CatalogArrival,
    CatalogProduct,
)


@dataclass(frozen=True)
class CatalogFilter:
    organization_id: str
    store_code: str | None
    query: str | None
    date_from: date | None
    date_to: date | None
    limit: int
    offset: int


class CatalogRepository(Protocol):
    def list_products(self, filters: CatalogFilter) -> tuple[list[CatalogProduct], int]:
        """Return one catalogue page and the total matching occurrences."""
        ...

    def get_arrival(
        self, organization_id: str, batch_id: str, store_code: str | None
    ) -> CatalogArrival | None:
        """Return the complete latest arrival sheet when visible."""
        ...

    def image_checksum(
        self, organization_id: str, batch_id: str, store_code: str | None
    ) -> str | None:
        """Return the source image checksum when the batch is visible."""
        ...
