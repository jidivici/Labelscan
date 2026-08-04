"""Read-only endpoint for batches (query adapter).

No writes, no domain logic. Read-only cross-schema joins assemble the read model
(batch + supplier/product + linked alerts + audit). Returns exactly what exists,
including `status` ('registered' | 'flagged').
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Path, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.platform.db.tenant_context import set_tenant_context
from labelscan.platform.http.deps import get_engine
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.read_models import AuditEntry, audit_entries
from labelscan.platform.http.security import Principal, require_scope

router = APIRouter()


def _organization_id(conn, principal: Principal) -> str:
    if principal.organization_id:
        return principal.organization_id
    return str(
        conn.execute(
            text("SELECT id FROM identity.organization WHERE slug = 'labelscan'")
        ).scalar_one()
    )


class BatchAlert(BaseModel):
    id: str
    alert_type: str
    severity: str
    state: str
    control_plan_version: str | None
    detail: Any
    created_at: str
    updated_at: str


class BatchView(BaseModel):
    batch_id: str
    lot_code: str
    gtin: str | None
    status: str
    species_scientific: str | None
    fao_area_code: str | None
    production_method: str | None
    use_by: str | None
    packaging_date: str | None
    source_ingestion_id: str
    source_extraction_run_id: str
    supplier_name: str | None
    product_common_name: str | None
    product_scientific_name: str | None
    created_at: str
    alerts: list[BatchAlert]
    audit: list[AuditEntry]


@router.get("/v1/batches/{batch_id}", response_model=BatchView)
def get_batch(
    request: Request,
    batch_id: str = Path(min_length=1, max_length=128),
    principal: Principal = Depends(require_scope("traceability:read")),
    engine: Engine = Depends(get_engine),
) -> BatchView:
    with engine.connect() as c:
        organization_id = _organization_id(c, principal)
        set_tenant_context(c, organization_id)
        row = (
            c.execute(
                text(
                    "SELECT b.id::text AS batch_id, b.lot_code, b.gtin, b.status, b.species_scientific, "
                    "b.fao_area_code, b.production_method, b.use_by::text AS use_by, "
                    "b.packaging_date::text AS packaging_date, b.source_ingestion_id::text AS source_ingestion_id, "
                    "b.source_extraction_run_id::text AS source_extraction_run_id, b.created_at::text AS created_at, "
                    "s.name AS supplier_name, p.common_name AS product_common_name, "
                    "p.scientific_name AS product_scientific_name "
                    "FROM traceability.batch b "
                    "LEFT JOIN traceability.supplier s ON s.id = b.supplier_id "
                    "LEFT JOIN traceability.product p ON p.id = b.product_id "
                    "WHERE b.id = :id AND b.organization_id = :organization_id "
                    "AND (:all_stores OR b.store_id::text = :store_id)"
                ),
                {
                    "id": batch_id,
                    "organization_id": organization_id,
                    "all_stores": principal.role == "admin",
                    "store_id": principal.store_id or "",
                },
            )
            .mappings()
            .first()
        )
        if row is None:
            raise ApiError("NOT_FOUND", f"batch {batch_id} not found")
        alerts = (
            c.execute(
                text(
                    "SELECT id::text AS id, alert_type, severity, state, control_plan_version, detail, "
                    "created_at::text AS created_at, updated_at::text AS updated_at "
                    "FROM haccp.alert WHERE batch_id = :id ORDER BY created_at"
                ),
                {"id": batch_id},
            )
            .mappings()
            .all()
        )
        audit = audit_entries(c, batch_id)

    return BatchView(**row, alerts=[BatchAlert(**a) for a in alerts], audit=audit)
