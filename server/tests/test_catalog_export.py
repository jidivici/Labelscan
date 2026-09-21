"""Security contract for the authenticated, tenant-scoped catalogue export."""

from __future__ import annotations

import csv
import io
import json

from fastapi.testclient import TestClient

from labelscan.app.http_app import create_app
from labelscan.contexts.traceability.adapters.http.catalog_router import (
    get_catalog_export_audit,
    get_catalog_service,
)
from labelscan.contexts.traceability.domain.catalog import CatalogProduct
from tests.conftest import bearer

ORGANIZATION_ID = "22222222-2222-2222-2222-222222222222"


def _product(*, name: str = "Cabillaud") -> CatalogProduct:
    return CatalogProduct(
        batch_id="33333333-3333-3333-3333-333333333333",
        store_code="STORE-01",
        product_name=name,
        scientific_name="Gadus morhua",
        gtin="4006381333931",
        lot_code="LOT-01",
        supplier_name="Fournisseur",
        status="registered",
        fao_area_code="27.7",
        production_method="wild_caught",
        use_by="2026-09-01",
        packaging_date="2026-08-31",
        recorded_at="2026-08-31T10:00:00+00:00",
        captured_by_user_id="44444444-4444-4444-4444-444444444444",
    )


class _CatalogStub:
    def __init__(self, products: list[CatalogProduct], *, total: int | None = None):
        self.products = products
        self.total = len(products) if total is None else total
        self.queries = []

    def list(self, query):
        self.queries.append(query)
        return self.products[query.offset : query.offset + query.limit], self.total


class _AuditStub:
    def __init__(self) -> None:
        self.events: list[dict[str, object]] = []

    def record(self, **event: object) -> None:
        self.events.append(event)


def _client(
    service: _CatalogStub, audit: _AuditStub | None = None
) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_catalog_service] = lambda: service
    app.dependency_overrides[get_catalog_export_audit] = lambda: audit or _AuditStub()
    return TestClient(app)


def _headers(scope: str = "export:read") -> dict[str, str]:
    return bearer(scope, organization_id=ORGANIZATION_ID)


def test_export_requires_authentication_and_export_scope() -> None:
    client = _client(_CatalogStub([_product()]))

    assert client.get("/v1/arrivals/export").status_code == 401
    assert client.get(
        "/v1/arrivals/export", headers=_headers("catalog:read")
    ).status_code == 403


def test_json_export_uses_allowlist_and_tenant_context() -> None:
    service = _CatalogStub([_product()])
    audit = _AuditStub()
    response = _client(service, audit).get(
        "/v1/arrivals/export?format=json", headers=_headers()
    )

    assert response.status_code == 200
    row = response.json()[0]
    assert row["product_name"] == "Cabillaud"
    assert "captured_by_user_id" not in row
    assert "photo_available" not in row
    assert "token" not in json.dumps(row).casefold()
    assert service.queries[0].access.organization_id == ORGANIZATION_ID
    assert response.headers["x-export-row-count"] == "1"
    assert len(audit.events) == 1
    event = audit.events[0]
    assert event["actor_id"] == "11111111-1111-1111-1111-111111111111"
    assert event["correlation_id"] == response.headers["x-correlation-id"]
    assert event["export_format"] == "json"
    assert event["organization_id"] == ORGANIZATION_ID
    assert event["row_count"] == 1
    assert event["trace_id"]
    assert len(str(event["filter_sha256"])) == 64


def test_csv_export_neutralizes_spreadsheet_formulas() -> None:
    response = _client(_CatalogStub([_product(name="  =HYPERLINK(\"x\")")])).get(
        "/v1/arrivals/export?format=csv", headers=_headers()
    )

    assert response.status_code == 200
    row = next(csv.DictReader(io.StringIO(response.text)))
    assert row["product_name"].startswith("'")
    assert row["product_name"].lstrip("' ").startswith("=")


def test_export_refuses_more_than_ten_thousand_rows_without_truncating() -> None:
    audit = _AuditStub()
    response = _client(_CatalogStub([_product()], total=10_001), audit).get(
        "/v1/arrivals/export", headers=_headers()
    )

    assert response.status_code == 413
    assert response.json()["error_code"] == "EXPORT_TOO_LARGE"
    assert audit.events == []


def test_export_counts_only_the_first_page() -> None:
    service = _CatalogStub([_product() for _ in range(201)])
    response = _client(service).get("/v1/arrivals/export", headers=_headers())

    assert response.status_code == 200
    assert len(service.queries) == 2
    assert service.queries[0].include_total is True
    assert service.queries[1].include_total is False


def test_export_rejects_unsafe_or_malformed_filters() -> None:
    client = _client(_CatalogStub([_product()]))

    assert client.get(
        "/v1/arrivals/export",
        params={"business_portal_id": "not-a-uuid"},
        headers=_headers(),
    ).status_code == 400


def test_catalog_filters_validate_uuid_gtin_and_unicode() -> None:
    service = _CatalogStub([_product()])
    client = _client(service)
    headers = _headers("catalog:read")

    assert client.get(
        "/v1/arrivals",
        params={"captured_by_user_id": "not-a-uuid"},
        headers=headers,
    ).status_code == 400
    assert client.get(
        "/v1/arrivals",
        params={
            "business_portal_id": "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"
        },
        headers=headers,
    ).status_code == 400
    assert client.get(
        "/v1/arrivals",
        params={"gtin": "4006381333932"},
        headers=headers,
    ).status_code == 400
    assert client.get(
        "/v1/arrivals/not-a-uuid",
        headers=headers,
    ).status_code == 400

    normalized = client.get(
        "/v1/arrivals",
        params={"q": "Cafe\u0301"},
        headers=headers,
    )
    assert normalized.status_code == 200
    assert service.queries[-1].query == "Café"
    assert client.get(
        "/v1/arrivals/export",
        params={"q": "safe\u202etxt.exe"},
        headers=_headers(),
    ).status_code == 400


def test_profession_field_specs_have_a_closed_typed_openapi_schema() -> None:
    schemas = create_app().openapi()["components"]["schemas"]

    field_specs = schemas["ProfessionResponse"]["properties"]["field_specs"]
    assert field_specs["additionalProperties"] == {
        "$ref": "#/components/schemas/FieldSpecResponse"
    }
    assert schemas["FieldSpecResponse"]["additionalProperties"] is False
    assert set(schemas["FieldSpecResponse"]["required"]) == {
        "kind",
        "format",
        "max_length",
        "enum",
        "units",
        "nullable",
    }
