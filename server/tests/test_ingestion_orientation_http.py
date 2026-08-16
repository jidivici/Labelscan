"""The public ingestion boundary accepts only landscape-oriented image bytes."""

from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image

from labelscan.app.http_app import create_app
from labelscan.contexts.ingestion.adapters.http.router import get_submit_ingestion
from tests.conftest import bearer


class _MustNotRun:
    def __call__(self, command):
        raise AssertionError("non-landscape bytes reached the ingestion use case")


def _submit_non_landscape(width: int, height: int):
    encoded = BytesIO()
    Image.new("RGB", (width, height), "white").save(encoded, format="JPEG")
    app = create_app()
    app.dependency_overrides[get_submit_ingestion] = lambda: _MustNotRun()

    with TestClient(app) as client:
        response = client.post(
            "/v1/ingestions",
            files={"image": ("non-landscape.jpg", encoded.getvalue(), "image/jpeg")},
            headers={"Idempotency-Key": f"orientation-{width}-{height}", **bearer("ingestion:write")},
        )

    return response


def test_portrait_photo_is_rejected_before_ingestion() -> None:
    response = _submit_non_landscape(400, 800)

    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"
    assert "only landscape" in response.json()["detail"]


def test_square_photo_is_rejected_before_ingestion() -> None:
    response = _submit_non_landscape(600, 600)

    assert response.status_code == 400
    assert response.json()["error_code"] == "VALIDATION_ERROR"
