"""HTTP proof for authenticated arrival images."""

from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image

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


def test_thumbnail_variant_returns_a_small_display_jpeg() -> None:
    source = BytesIO()
    Image.new("RGB", (1600, 900), "#167568").save(source, format="PNG")

    class ImageReader:
        def read(self, checksum):
            return RawImage(content=source.getvalue(), media_type="image/png")

    app = create_app()
    app.dependency_overrides[get_catalog_service] = lambda: CatalogService(
        _ImageRepository()
    )
    app.dependency_overrides[get_raw_image_reader] = lambda: ImageReader()

    with TestClient(app) as client:
        response = client.get(
            "/v1/arrivals/batch-visible/image?variant=thumbnail",
            headers=bearer(
                "catalog:read",
                role="operator",
                store_code="PARIS-01",
                organization_id="11111111-1111-1111-1111-111111111110",
            ),
        )

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["cache-control"] == "no-store"
    assert len(response.content) < len(source.getvalue())
    with Image.open(BytesIO(response.content)) as thumbnail:
        assert max(thumbnail.size) == 480
