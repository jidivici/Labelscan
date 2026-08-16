"""HTTP proof for authenticated arrival images."""

from fastapi.testclient import TestClient

from labelscan.app.http_app import create_app
from labelscan.contexts.traceability.adapters.http.catalog_router import (
    get_catalog_service,
    get_raw_image_reader,
)
from labelscan.contexts.traceability.application.catalog import CatalogService
from labelscan.platform.raw_images import RawImage
from tests.conftest import bearer


class _ImageRepository:
    def list_products(self, filters):
        return [], 0

    def image_checksum(self, batch_id, store_code):
        if batch_id == "batch-visible" and store_code == "PARIS-01":
            return "a" * 64
        return None


class _ImageReader:
    def read(self, checksum):
        assert checksum == "a" * 64
        return RawImage(content=b"\x89PNG\r\n\x1a\nimage", media_type="image/png")


def test_operator_can_load_only_its_store_arrival_image() -> None:
    app = create_app()
    app.dependency_overrides[get_catalog_service] = lambda: CatalogService(
        _ImageRepository()
    )
    app.dependency_overrides[get_raw_image_reader] = lambda: _ImageReader()

    with TestClient(app) as client:
        visible = client.get(
            "/v1/arrivals/batch-visible/image",
            headers=bearer(
                "catalog:read",
                role="operator",
                store_code="PARIS-01",
                organization_id="11111111-1111-1111-1111-111111111110",
            ),
        )
        hidden = client.get(
            "/v1/arrivals/batch-visible/image",
            headers=bearer(
                "catalog:read",
                role="operator",
                store_code="LYON-02",
                organization_id="11111111-1111-1111-1111-111111111110",
            ),
        )

    assert visible.status_code == 200
    assert visible.headers["content-type"] == "image/png"
    assert visible.content.startswith(b"\x89PNG")
    assert hidden.status_code == 404
