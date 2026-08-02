"""HTTP/DB proofs for the store-scoped arrivals feed."""

from __future__ import annotations

import json
import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.traceability.adapters.http.catalog_router import (
    get_catalog_service,
)
from labelscan.contexts.traceability.adapters.sql_catalog_repository import (
    SqlCatalogRepository,
)
from labelscan.contexts.traceability.application.catalog import CatalogService
from labelscan.platform.db.audit_context import set_audit_context
from tests.conftest import ACTOR_ID, bearer

STORE_CODE = "CATALOG-TEST-01"


@pytest.fixture
def catalog_record(engine):
    suffix = uuid.uuid4().hex[:10]
    product_name = f"Cabillaud catalogue {suffix}"
    lot_code = f"LOT-{suffix}"
    with engine.begin() as conn:
        set_audit_context(
            conn,
            actor_id=ACTOR_ID,
            action="traceability.catalog_test_seeded",
            correlation_id=f"catalog-{suffix}",
            trace_id=f"catalog-{suffix}",
        )
        product_id = conn.execute(
            text(
                "INSERT INTO traceability.product "
                "(common_name, scientific_name, correlation_id, trace_id) "
                "VALUES (:name, 'Gadus morhua', :corr, :corr) RETURNING id"
            ),
            {"name": product_name, "corr": f"catalog-{suffix}"},
        ).scalar_one()
        supplier_id = conn.execute(
            text(
                "INSERT INTO traceability.supplier "
                "(name, correlation_id, trace_id) "
                "VALUES (:name, :corr, :corr) RETURNING id"
            ),
            {
                "name": f"Fournisseur catalogue {suffix}",
                "corr": f"catalog-{suffix}",
            },
        ).scalar_one()
        ingestion_id = str(uuid.uuid4())
        extraction_run_id = str(uuid.uuid4())
        conn.execute(
            text(
                "INSERT INTO ingestion.ingestion "
                "(id, status, image_ref, checksum_sha256, correlation_id, trace_id) "
                "VALUES (:id, 'confirmed', :image_ref, :checksum, :corr, :corr)"
            ),
            {
                "id": ingestion_id,
                "image_ref": f"sha256://{suffix}",
                "checksum": suffix.ljust(64, "0"),
                "corr": f"catalog-{suffix}",
            },
        )
        conn.execute(
            text(
                "INSERT INTO ingestion.extraction_run "
                "(id, ingestion_id, attempt_no, outcome, extractor_version, "
                "prompt_version, ocr_provider, llm_model, rule_set_version, "
                "correlation_id, trace_id) "
                "VALUES (:id, :ingestion, 1, 'extracted', 'test', 'test', "
                "'test', 'test', 'test', :corr, :corr)"
            ),
            {
                "id": extraction_run_id,
                "ingestion": ingestion_id,
                "corr": f"catalog-{suffix}",
            },
        )
        batch_id = conn.execute(
            text(
                "INSERT INTO traceability.batch "
                "(lot_code, product_id, supplier_id, store_code, status, "
                "source_ingestion_id, source_extraction_run_id, "
                "correlation_id, trace_id) "
                "VALUES (:lot, :product, :supplier, :store, 'registered', "
                ":ingestion, :run, :corr, :corr) RETURNING id"
            ),
            {
                "lot": lot_code,
                "product": product_id,
                "supplier": supplier_id,
                "store": STORE_CODE,
                "ingestion": ingestion_id,
                "run": extraction_run_id,
                "corr": f"catalog-{suffix}",
            },
        ).scalar_one()
        conn.execute(
            text(
                "INSERT INTO traceability.arrival_projection "
                "(batch_id, organization_id, store_code, ingestion_id, "
                "extraction_run_id, fields, image_ref, image_checksum, recorded_at) "
                "VALUES (:batch, platform.default_organization_id(), :store, "
                ":ingestion, :run, CAST(:fields AS jsonb), :image_ref, :checksum, now())"
            ),
            {
                "batch": batch_id,
                "store": STORE_CODE,
                "ingestion": ingestion_id,
                "run": extraction_run_id,
                "fields": json.dumps(
                    {
                        "commercial_designation": product_name,
                        "scientific_name": "Gadus morhua",
                        "batch_number": lot_code,
                    }
                ),
                "image_ref": f"sha256://{suffix}",
                "checksum": suffix.ljust(64, "0"),
            },
        )
    return {
        "batch_id": str(batch_id),
        "product_name": product_name,
        "lot_code": lot_code,
    }


@pytest.fixture
def client(engine):
    app = create_app()
    app.dependency_overrides[get_catalog_service] = lambda: CatalogService(
        SqlCatalogRepository(engine)
    )
    return TestClient(app)


def test_operator_can_search_only_its_store_arrivals(client, catalog_record):
    response = client.get(
        "/v1/arrivals",
        headers=bearer(
            "catalog:read",
            role="operator",
            store_code=STORE_CODE,
        ),
        params={
            "q": catalog_record["lot_code"],
            "date_from": date.today().isoformat(),
            "date_to": date.today().isoformat(),
        },
    )
    assert response.status_code == 200
    page = response.json()
    assert page["total"] == 1
    assert page["items"][0]["batch_id"] == catalog_record["batch_id"]
    assert page["items"][0]["store_code"] == STORE_CODE
    assert page["items"][0]["product_name"] == catalog_record["product_name"]


def test_operator_cannot_override_its_store_filter(client, catalog_record):
    response = client.get(
        "/v1/arrivals",
        headers=bearer(
            "catalog:read",
            role="operator",
            store_code=STORE_CODE,
        ),
        params={"store_code": "ANOTHER-STORE"},
    )
    assert response.status_code == 403
    assert response.json()["error_code"] == "FORBIDDEN"


def test_admin_can_filter_arrivals_by_store(client, catalog_record):
    response = client.get(
        "/v1/arrivals",
        headers=bearer("catalog:read identity:admin"),
        params={
            "store_code": STORE_CODE,
            "q": catalog_record["product_name"],
        },
    )
    assert response.status_code == 200
    assert response.json()["items"][0]["batch_id"] == catalog_record["batch_id"]


def test_legacy_catalogue_route_remains_available(client, catalog_record):
    response = client.get(
        "/v1/catalog/products",
        headers=bearer("catalog:read identity:admin"),
        params={"q": catalog_record["lot_code"]},
    )
    assert response.status_code == 200
    assert response.json()["items"][0]["batch_id"] == catalog_record["batch_id"]
