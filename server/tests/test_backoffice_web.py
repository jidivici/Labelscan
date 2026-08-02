from fastapi.testclient import TestClient

from labelscan.app.http_app import create_app


def test_backoffice_and_brand_assets_are_served() -> None:
    with TestClient(create_app()) as client:
        page = client.get("/backoffice/")
        script = client.get("/backoffice/app.js")
        logo = client.get("/backoffice/assets/labelscan-logo.png")

    assert page.status_code == 200
    assert "Utilisateurs" in page.text
    assert "Arrivages" in page.text
    assert "Magasins" in page.text
    assert 'id="manage-stores-button"' in page.text
    assert 'id="catalog-filter-toggle"' in page.text
    assert 'id="catalog-search"' in page.text
    assert 'id="catalog-grid" class="catalog-grid"' in page.text
    assert 'id="catalog-table-body"' not in page.text
    assert 'id="mobile-menu-button"' not in page.text
    assert (
        'id="portal-brand" class="sidebar-brand" href="#catalog-section"'
        in page.text
    )
    assert 'maxlength="256"' not in page.text
    assert 'minlength="12"' not in page.text
    assert script.status_code == 200
    assert "javascript" in script.headers["content-type"]
    assert "/v1/arrivals" in script.text
    assert "product-card" in script.text
    assert "data-arrival-image" in script.text
    assert "Chargement de la photo" in script.text
    assert "window.sessionStorage.setItem" in script.text
    assert "window.sessionStorage.getItem" in script.text
    assert "restoreSession();" in script.text
    assert "reste active après un rechargement" in page.text
    assert logo.status_code == 200
    assert logo.headers["content-type"] == "image/png"
