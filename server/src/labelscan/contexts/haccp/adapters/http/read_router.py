"""Read-only list endpoint for alerts (query adapter).

No writes, no domain logic. Filterable + paginated; each alert carries its
`state` (status) and its latest audit metadata (actor_id, occurred_at) via a
single lateral join (no N+1). Returns exactly what exists.
"""

from __future__ import annotations

import unicodedata
from collections import Counter
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, BeforeValidator
from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.platform.db.tenant_context import set_tenant_context
from labelscan.platform.http.access import (
    access_context_for_principal,
    postgres_scope,
)
from labelscan.platform.http.deps import get_engine
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.read_models import AuditEntry
from labelscan.platform.http.security import Principal, require_scope

router = APIRouter()

_BIDI_CONTROL_CLASSES = frozenset(
    {"RLE", "LRE", "RLO", "LRO", "PDF", "RLI", "LRI", "FSI", "PDI"}
)
_ALERT_QUERY_PARAMETERS = frozenset(
    {
        "state",
        "alert_type",
        "severity",
        "batch_id",
        "business_portal_id",
        "profession",
        "limit",
        "offset",
    }
)
_CANONICAL_UUID_PATTERN = (
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
_TEXT_QUERY_PARAMETERS = frozenset(
    {
        "state",
        "alert_type",
        "severity",
        "batch_id",
        "business_portal_id",
        "profession",
    }
)


def _safe_query_token(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("query value must be a string")
    normalized = unicodedata.normalize("NFC", value)
    if any(
        unicodedata.category(character) in {"Cc", "Cf", "Cs"}
        or unicodedata.bidirectional(character) in _BIDI_CONTROL_CLASSES
        for character in normalized
    ):
        raise ValueError("query value contains invalid characters")
    return normalized


def _parse_canonical_uuid(value: object) -> UUID:
    value = _safe_query_token(value)
    try:
        parsed = UUID(value)
    except ValueError as exc:
        raise ValueError("UUID filter is invalid") from exc
    if value != str(parsed):
        raise ValueError("UUID filter must use canonical lowercase form")
    return parsed


def _parse_query_integer(value: object) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
        raise ValueError("pagination value must be an unsigned decimal integer")
    return int(value)


QueryInteger = Annotated[int, BeforeValidator(_parse_query_integer)]
AlertState = Annotated[
    Literal["open", "acknowledged", "resolved"], BeforeValidator(_safe_query_token)
]
AlertType = Annotated[
    Literal["expiry", "temperature", "required_field", "inconsistency"],
    BeforeValidator(_safe_query_token),
]
AlertSeverity = Annotated[
    Literal["low", "medium", "high", "critical"],
    BeforeValidator(_safe_query_token),
]
Profession = Annotated[
    Literal["poissonnerie", "boucherie", "charcuterie_traiteur"],
    BeforeValidator(_safe_query_token),
]


def _require_query_shape(request: Request) -> None:
    pairs = request.query_params.multi_items()
    keys = [key for key, _ in pairs]
    unknown = sorted(set(keys) - _ALERT_QUERY_PARAMETERS)
    duplicates = sorted(key for key, count in Counter(keys).items() if count > 1)
    if unknown:
        raise ApiError("VALIDATION_ERROR", "unknown alert query parameter")
    if duplicates:
        raise ApiError("VALIDATION_ERROR", "query parameters must be singular")
    try:
        for key, value in pairs:
            if key in _TEXT_QUERY_PARAMETERS:
                _safe_query_token(value)
            elif key in {"limit", "offset"}:
                _parse_query_integer(value)
    except ValueError as exc:
        raise ApiError("VALIDATION_ERROR", str(exc)) from exc


class AlertItem(BaseModel):
    id: str
    batch_id: str | None
    alert_type: str
    severity: str
    state: str
    control_plan_version: str | None
    detail: Any
    created_at: str
    updated_at: str
    audit: AuditEntry | None
    organization_id: str | None = None
    store_id: str | None = None
    business_portal_id: str | None = None
    profession_code: str | None = None


class AlertPage(BaseModel):
    items: list[AlertItem]
    limit: int
    offset: int


@router.get("/v1/alerts", response_model=AlertPage)
def list_alerts(
    request: Request,
    state: AlertState | None = Query(None),
    alert_type: AlertType | None = Query(None),
    severity: AlertSeverity | None = Query(None),
    batch_id: str | None = Query(
        None, min_length=36, max_length=36, pattern=_CANONICAL_UUID_PATTERN
    ),
    business_portal_id: str | None = Query(
        None, min_length=36, max_length=36, pattern=_CANONICAL_UUID_PATTERN
    ),
    profession: Profession | None = Query(None),
    limit: QueryInteger = Query(50, ge=1, le=200),
    offset: QueryInteger = Query(0, ge=0, le=100_000),
    principal: Principal = Depends(require_scope("haccp:read")),
    engine: Engine = Depends(get_engine),
) -> AlertPage:
    _require_query_shape(request)
    batch_id_text = str(_parse_canonical_uuid(batch_id)) if batch_id else None
    business_portal_id_text = (
        str(_parse_canonical_uuid(business_portal_id)) if business_portal_id else None
    )
    conds, params = [], {"limit": limit, "offset": offset}
    for col, val in (
        ("state", state),
        ("alert_type", alert_type),
        ("severity", severity),
    ):
        if val is not None:
            conds.append(f"a.{col} = :{col}")
            params[col] = val
    if batch_id_text is not None:
        conds.append("a.batch_id::text = :batch_id")
        params["batch_id"] = batch_id_text
    if business_portal_id_text is not None:
        conds.append("a.business_portal_id::text = :business_portal_id")
        params["business_portal_id"] = business_portal_id_text
    with engine.connect() as c:
        organization_id = principal.organization_id or str(
            c.execute(
                text("SELECT id FROM identity.organization WHERE slug = 'labelscan'")
            ).scalar_one()
        )
        set_tenant_context(c, organization_id)
        access = access_context_for_principal(
            principal, default_organization_id=organization_id
        )
        scope, scope_params = postgres_scope(access, alias="a")
        conds.insert(0, scope)
        params.update(scope_params)
        if profession is not None:
            conds.append("portal.profession_code = :profession")
            params["profession"] = profession
        where = "WHERE " + " AND ".join(conds)
        sql = text(
            "SELECT a.id::text AS id, a.batch_id::text AS batch_id, a.alert_type, a.severity, a.state, "
            "a.organization_id::text AS organization_id, a.store_id::text AS store_id, "
            "a.business_portal_id::text AS business_portal_id, portal.profession_code, "
            "a.control_plan_version, a.detail, a.created_at::text AS created_at, a.updated_at::text AS updated_at, "
            "au.actor_id::text AS au_actor, au.action AS au_action, au.occurred_at::text AS au_occurred "
            "FROM haccp.alert a "
            "LEFT JOIN identity.business_portal portal ON portal.id = a.business_portal_id "
            "LEFT JOIN LATERAL (SELECT actor_id, action, occurred_at FROM audit.audit_log "
            "                   WHERE subject_id = a.id ORDER BY occurred_at DESC LIMIT 1) au ON true "
            f"{where} ORDER BY a.created_at DESC LIMIT :limit OFFSET :offset"
        )
        rows = c.execute(sql, params).mappings().all()

    items = [
        AlertItem(
            id=r["id"],
            batch_id=r["batch_id"],
            alert_type=r["alert_type"],
            severity=r["severity"],
            state=r["state"],
            control_plan_version=r["control_plan_version"],
            detail=r["detail"],
            created_at=r["created_at"],
            updated_at=r["updated_at"],
            audit=(
                AuditEntry(
                    actor_id=r["au_actor"],
                    action=r["au_action"],
                    occurred_at=r["au_occurred"],
                )
                if r["au_actor"]
                else None
            ),
            organization_id=r["organization_id"],
            store_id=r["store_id"],
            business_portal_id=r["business_portal_id"],
            profession_code=r["profession_code"],
        )
        for r in rows
    ]
    return AlertPage(items=items, limit=limit, offset=offset)
