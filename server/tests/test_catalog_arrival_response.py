from labelscan.contexts.traceability.adapters.http.catalog_router import (
    CatalogArrivalResponse,
    CatalogProductResponse,
)
from labelscan.contexts.traceability.domain.catalog import CatalogArrival, CatalogProduct


def test_arrival_response_exposes_persisted_photo_rotation() -> None:
    arrival = CatalogArrival(
        batch_id="batch-1",
        ingestion_id="ingestion-1",
        organization_id="organization-1",
        store_code="PARIS-01",
        status="registered",
        fields={},
        validation={},
        revision_no=1,
        recorded_at="2026-08-16T10:00:00Z",
        updated_at="2026-08-16T10:00:00Z",
        photo_available=True,
        photo_rotation_degrees=180,
    )

    response = CatalogArrivalResponse.from_domain(arrival)

    assert response.photo_rotation_degrees == 180


def test_catalog_summary_exposes_persisted_photo_rotation() -> None:
    product = CatalogProduct(
        batch_id="batch-1",
        store_code="PARIS-01",
        product_name="Saumon",
        scientific_name="Salmo salar",
        gtin=None,
        lot_code="LOT-1",
        supplier_name=None,
        status="registered",
        fao_area_code=None,
        production_method="farmed",
        use_by=None,
        packaging_date=None,
        recorded_at="2026-08-16T10:00:00Z",
        photo_rotation_degrees=180,
    )

    response = CatalogProductResponse.from_domain(product)

    assert response.photo_rotation_degrees == 180
