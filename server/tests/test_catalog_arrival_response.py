from labelscan.contexts.traceability.adapters.http.catalog_router import (
    CatalogArrivalResponse,
)
from labelscan.contexts.traceability.domain.catalog import CatalogArrival


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
