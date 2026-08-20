from fastapi.testclient import TestClient

from labelscan.app.http_app import create_app


def test_backoffice_brand_asset_is_served() -> None:
    with TestClient(create_app()) as client:
        logo = client.get("/backoffice/assets/labelscan-logo.png")

    assert logo.status_code == 200
    assert logo.headers["content-type"] == "image/png"
