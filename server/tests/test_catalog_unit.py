"""Database-free proofs for store-scoped catalogue authorization."""

from __future__ import annotations

from datetime import date

import pytest

from labelscan.contexts.traceability.application.catalog import (
    CatalogAccess,
    CatalogAccessDenied,
    CatalogArrivalNotFound,
    CatalogImageQuery,
    CatalogQuery,
    CatalogService,
    CatalogStoreRequired,
)
from labelscan.contexts.traceability.domain.catalog import CatalogProduct


class _FakeCatalogRepository:
    def __init__(self) -> None:
        self.filters = None
        self.image_request = None

    def list_products(self, filters):
        self.filters = filters
        return (
            [
                CatalogProduct(
                    batch_id="batch-1",
                    store_code=filters.store_code,
                    product_name="Cabillaud",
                    scientific_name="Gadus morhua",
                    gtin=None,
                    lot_code="LOT-01",
                    supplier_name="Atlantique",
                    status="registered",
                    fao_area_code="27",
                    production_method="wild_caught",
                    use_by="2026-07-30",
                    packaging_date="2026-07-25",
                    recorded_at="2026-07-26T10:00:00+00:00",
                )
            ],
            1,
        )

    def image_checksum(self, batch_id, store_code):
        self.image_request = (batch_id, store_code)
        if batch_id != "batch-1" or store_code == "LYON-02":
            return None
        return "a" * 64


def test_operator_catalogue_is_forced_to_its_store():
    repository = _FakeCatalogRepository()
    products, total = CatalogService(repository).list(
        CatalogQuery(
            access=CatalogAccess(store_code="paris-01"),
            query=" cabillaud ",
            date_from=date(2026, 7, 1),
            date_to=date(2026, 7, 31),
        )
    )
    assert total == 1
    assert products[0].store_code == "PARIS-01"
    assert repository.filters.store_code == "PARIS-01"
    assert repository.filters.query == "cabillaud"


def test_operator_cannot_request_another_store():
    with pytest.raises(CatalogAccessDenied):
        CatalogService(_FakeCatalogRepository()).list(
            CatalogQuery(
                access=CatalogAccess(store_code="PARIS-01"),
                requested_store_code="LYON-02",
            )
        )


def test_unassigned_operator_cannot_open_catalogue():
    with pytest.raises(CatalogStoreRequired):
        CatalogService(_FakeCatalogRepository()).list(
            CatalogQuery(access=CatalogAccess(store_code=None))
        )


def test_admin_can_view_all_stores_or_filter_one():
    repository = _FakeCatalogRepository()
    service = CatalogService(repository)
    service.list(
        CatalogQuery(
            access=CatalogAccess(store_code=None, can_view_all_stores=True)
        )
    )
    assert repository.filters.store_code is None
    service.list(
        CatalogQuery(
            access=CatalogAccess(store_code=None, can_view_all_stores=True),
            requested_store_code="lyon-02",
        )
    )
    assert repository.filters.store_code == "LYON-02"


def test_catalogue_rejects_an_inverted_date_range():
    with pytest.raises(ValueError, match="date_from"):
        CatalogService(_FakeCatalogRepository()).list(
            CatalogQuery(
                access=CatalogAccess(
                    store_code=None, can_view_all_stores=True
                ),
                date_from=date(2026, 8, 1),
                date_to=date(2026, 7, 1),
            )
        )


def test_operator_image_access_is_forced_to_its_store():
    repository = _FakeCatalogRepository()
    checksum = CatalogService(repository).image_checksum(
        CatalogImageQuery(
            access=CatalogAccess(store_code="paris-01"),
            batch_id="batch-1",
        )
    )
    assert checksum == "a" * 64
    assert repository.image_request == ("batch-1", "PARIS-01")


def test_hidden_arrival_image_is_reported_as_not_found():
    with pytest.raises(CatalogArrivalNotFound):
        CatalogService(_FakeCatalogRepository()).image_checksum(
            CatalogImageQuery(
                access=CatalogAccess(store_code="LYON-02"),
                batch_id="batch-1",
            )
        )
