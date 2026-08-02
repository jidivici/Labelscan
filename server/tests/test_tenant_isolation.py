"""Database and HTTP proofs that guessed identifiers cannot cross tenants."""

from __future__ import annotations

import json
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.contexts.traceability.adapters.http.catalog_router import (
    get_catalog_service,
    get_raw_image_reader,
)
from labelscan.contexts.traceability.adapters.sql_catalog_repository import (
    SqlCatalogRepository,
)
from labelscan.contexts.traceability.application.catalog import CatalogService
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.tenant_context import set_tenant_context
from labelscan.platform.raw_images import RawImage
from tests.conftest import bearer


class _TenantImageReader:
    def read(self, checksum, organization_id=None):
        return RawImage(
            content=b"\x89PNG\r\n\x1a\n" + checksum.encode(),
            media_type="image/png",
        )


def _seed_tenant(engine, label: str) -> dict[str, str]:
    ids = {
        name: str(uuid.uuid4())
        for name in (
            "organization",
            "user",
            "store",
            "ingestion",
            "run",
            "product",
            "supplier",
            "batch",
            "artifact",
        )
    }
    slug = f"tenant-{label.lower()}-{uuid.uuid4().hex[:8]}"
    code = f"{label.upper()}-{uuid.uuid4().hex[:8].upper()}"
    checksum = (label.lower() * 64)[:64]
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO identity.organization (id, slug, name) "
                "VALUES (:id, :slug, :name)"
            ),
            {
                "id": ids["organization"],
                "slug": slug,
                "name": f"Tenant {label}",
            },
        )
        set_audit_context(
            conn,
            actor_id=ids["user"],
            action="test.tenant_seed",
            correlation_id=f"tenant-{label}",
            trace_id=f"tenant-{label}",
        )
        conn.execute(
            text(
                "INSERT INTO identity.app_user "
                "(id, organization_id, organization_code, username, display_name, "
                "password_hash, role, active, created_by) "
                "VALUES (:id, :organization_id, :slug, :username, :username, "
                "'not-used', 'admin', true, :id)"
            ),
            {
                "id": ids["user"],
                "organization_id": ids["organization"],
                "slug": slug,
                "username": f"admin-{slug}",
            },
        )
        conn.execute(
            text(
                "INSERT INTO identity.store "
                "(id, organization_id, organization_code, code, name, created_by) "
                "VALUES (:id, :organization_id, :slug, :code, :name, :created_by)"
            ),
            {
                "id": ids["store"],
                "organization_id": ids["organization"],
                "slug": slug,
                "code": code,
                "name": f"Store {label}",
                "created_by": ids["user"],
            },
        )
        conn.execute(
            text(
                "INSERT INTO ingestion.ingestion "
                "(id, organization_id, store_id, store_code, status, image_ref, "
                "checksum_sha256, correlation_id, trace_id) "
                "VALUES (:id, :organization_id, :store_id, :store_code, "
                "'confirmed', :image_ref, :checksum, :corr, :corr)"
            ),
            {
                "id": ids["ingestion"],
                "organization_id": ids["organization"],
                "store_id": ids["store"],
                "store_code": code,
                "image_ref": f"organizations/{ids['organization']}/{checksum}",
                "checksum": checksum,
                "corr": f"tenant-{label}",
            },
        )
        conn.execute(
            text(
                "INSERT INTO ingestion.raw_artifact "
                "(id, organization_id, ingestion_id, artifact_kind, storage_ref, "
                "checksum_sha256, correlation_id, trace_id) "
                "VALUES (:id, :organization_id, :ingestion_id, 'image', "
                ":storage_ref, :checksum, :corr, :corr)"
            ),
            {
                "id": ids["artifact"],
                "organization_id": ids["organization"],
                "ingestion_id": ids["ingestion"],
                "storage_ref": f"organizations/{ids['organization']}/{checksum}",
                "checksum": checksum,
                "corr": f"tenant-{label}",
            },
        )
        conn.execute(
            text(
                "INSERT INTO ingestion.extraction_run "
                "(id, ingestion_id, attempt_no, outcome, extractor_version, "
                "prompt_version, ocr_provider, llm_model, rule_set_version, "
                "correlation_id, trace_id) "
                "VALUES (:id, :ingestion_id, 1, 'extracted', 'test', 'test', "
                "'test', 'test', 'test', :corr, :corr)"
            ),
            {
                "id": ids["run"],
                "ingestion_id": ids["ingestion"],
                "corr": f"tenant-{label}",
            },
        )
        conn.execute(
            text(
                "INSERT INTO traceability.product "
                "(id, common_name, correlation_id, trace_id) "
                "VALUES (:id, :name, :corr, :corr)"
            ),
            {
                "id": ids["product"],
                "name": f"Product {label}",
                "corr": f"tenant-{label}",
            },
        )
        conn.execute(
            text(
                "INSERT INTO traceability.supplier "
                "(id, name, correlation_id, trace_id) "
                "VALUES (:id, :name, :corr, :corr)"
            ),
            {
                "id": ids["supplier"],
                "name": f"Supplier {label}",
                "corr": f"tenant-{label}",
            },
        )
        conn.execute(
            text(
                "INSERT INTO traceability.batch "
                "(id, organization_id, store_id, store_code, lot_code, product_id, "
                "supplier_id, status, source_ingestion_id, source_extraction_run_id, "
                "correlation_id, trace_id) "
                "VALUES (:id, :organization_id, :store_id, :store_code, :lot, "
                ":product_id, :supplier_id, 'registered', :ingestion_id, :run_id, "
                ":corr, :corr)"
            ),
            {
                "id": ids["batch"],
                "organization_id": ids["organization"],
                "store_id": ids["store"],
                "store_code": code,
                "lot": f"LOT-{label}",
                "product_id": ids["product"],
                "supplier_id": ids["supplier"],
                "ingestion_id": ids["ingestion"],
                "run_id": ids["run"],
                "corr": f"tenant-{label}",
            },
        )
        conn.execute(
            text(
                "INSERT INTO traceability.arrival_projection "
                "(batch_id, organization_id, store_id, store_code, ingestion_id, "
                "extraction_run_id, fields, image_ref, image_checksum, recorded_at) "
                "VALUES (:batch_id, :organization_id, :store_id, :store_code, "
                ":ingestion_id, :run_id, CAST(:fields AS jsonb), :image_ref, "
                ":checksum, now())"
            ),
            {
                "batch_id": ids["batch"],
                "organization_id": ids["organization"],
                "store_id": ids["store"],
                "store_code": code,
                "ingestion_id": ids["ingestion"],
                "run_id": ids["run"],
                "fields": json.dumps(
                    {
                        "commercial_designation": f"Product {label}",
                        "batch_number": f"LOT-{label}",
                    }
                ),
                "image_ref": f"organizations/{ids['organization']}/{checksum}",
                "checksum": checksum,
            },
        )
    return {
        **ids,
        "slug": slug,
        "store_code": code,
        "checksum": checksum,
    }


def test_postgresql_rls_hides_every_tenant_owned_row(engine):
    tenant_a = _seed_tenant(engine, "A")
    tenant_b = _seed_tenant(engine, "B")
    with engine.begin() as conn:
        conn.execute(text("SET LOCAL ROLE labelscan_app"))
        set_tenant_context(conn, tenant_a["organization"])
        for table in (
            "identity.app_user",
            "identity.store",
            "ingestion.ingestion",
            "ingestion.raw_artifact",
            "traceability.batch",
            "traceability.arrival_projection",
        ):
            visible_a = conn.execute(
                text(
                    f"SELECT count(*) FROM {table} "
                    "WHERE organization_id = :organization_id"
                ),
                {"organization_id": tenant_a["organization"]},
            ).scalar_one()
            visible_b = conn.execute(
                text(
                    f"SELECT count(*) FROM {table} "
                    "WHERE organization_id = :organization_id"
                ),
                {"organization_id": tenant_b["organization"]},
            ).scalar_one()
            assert visible_a >= 1
            assert visible_b == 0


def test_catalog_detail_and_photo_reject_guessed_cross_tenant_ids(engine):
    tenant_a = _seed_tenant(engine, "C")
    tenant_b = _seed_tenant(engine, "D")
    app = create_app()
    app.dependency_overrides[get_catalog_service] = lambda: CatalogService(
        SqlCatalogRepository(engine)
    )
    app.dependency_overrides[get_raw_image_reader] = lambda: _TenantImageReader()
    headers = bearer(
        "catalog:read identity:admin",
        role="admin",
        organization_id=tenant_a["organization"],
        organization_slug=tenant_a["slug"],
    )
    with TestClient(app) as client:
        own = client.get(f"/v1/arrivals/{tenant_a['batch']}", headers=headers)
        other = client.get(f"/v1/arrivals/{tenant_b['batch']}", headers=headers)
        other_photo = client.get(
            f"/v1/arrivals/{tenant_b['batch']}/image",
            headers=headers,
        )
    assert own.status_code == 200
    assert other.status_code == 404
    assert other_photo.status_code == 404
