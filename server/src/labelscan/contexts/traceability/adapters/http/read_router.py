"""Read-only endpoint for batches (query adapter).

No writes, no domain logic. Read-only cross-schema joins assemble the read model
(batch + supplier/product + linked alerts + audit). Returns exactly what exists,
including `status` ('registered' | 'flagged').
"""

from __future__ import annotations

import unicodedata
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.platform.db.tenant_context import set_tenant_context
from labelscan.platform.http.access import (
    access_context_for_principal,
    postgres_scope,
)
from labelscan.platform.http.deps import get_engine
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.read_models import AuditEntry, audit_entries
from labelscan.platform.http.security import Principal, require_scope

router = APIRouter()

_BIDI_CONTROL_CLASSES = frozenset(
    {"RLE", "LRE", "RLO", "LRO", "PDF", "RLI", "LRI", "FSI", "PDI"}
)
_CANONICAL_UUID_PATTERN = (
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


def _parse_canonical_uuid(value: object) -> UUID:
    if isinstance(value, UUID):
        return value
    if not isinstance(value, str):
        raise ValueError("batch_id must be a canonical UUID string")
    normalized = unicodedata.normalize("NFC", value)
    if normalized != value or any(
        unicodedata.category(character) in {"Cc", "Cf", "Cs"}
        or unicodedata.bidirectional(character) in _BIDI_CONTROL_CLASSES
        for character in value
    ):
        raise ValueError("batch_id must be a canonical UUID string")
    try:
        parsed = UUID(value)
    except ValueError as exc:
        raise ValueError("batch_id must be a canonical UUID string") from exc
    if value != str(parsed):
        raise ValueError("batch_id must use canonical lowercase UUID form")
    return parsed


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
    batch_id: str = Path(min_length=36, max_length=36, pattern=_CANONICAL_UUID_PATTERN),
    principal: Principal = Depends(require_scope("traceability:read")),
    engine: Engine = Depends(get_engine),
) -> BatchView:
    if request.query_params:
        raise ApiError("VALIDATION_ERROR", "this endpoint accepts no query parameters")
    batch_id_text = str(_parse_canonical_uuid(batch_id))
    with engine.connect() as c:
        organization_id = _organization_id(c, principal)
        set_tenant_context(c, organization_id)
        access = access_context_for_principal(
            principal, default_organization_id=organization_id
        )
        scope, scope_params = postgres_scope(access, alias="b")
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
                    "WHERE b.id = :id AND " + scope
                ),
                {
                    "id": batch_id_text,
                    **scope_params,
                },
            )
            .mappings()
            .first()
        )
        if row is None:
            raise ApiError("NOT_FOUND", f"batch {batch_id_text} not found")
        alerts = (
            c.execute(
                text(
                    "SELECT id::text AS id, alert_type, severity, state, control_plan_version, detail, "
                    "created_at::text AS created_at, updated_at::text AS updated_at "
                    "FROM haccp.alert WHERE batch_id = :id ORDER BY created_at"
                ),
                {"id": batch_id_text},
            )
            .mappings()
            .all()
        )
        audit = audit_entries(c, batch_id_text)

    return BatchView(**row, alerts=[BatchAlert(**a) for a in alerts], audit=audit)
