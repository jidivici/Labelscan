"""Read-only list endpoint for alerts (query adapter).

No writes, no domain logic. Filterable + paginated; each alert carries its
`state` (status) and its latest audit metadata (actor_id, occurred_at) via a
single lateral join (no N+1). Returns exactly what exists.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.platform.http.deps import get_engine
from labelscan.platform.http.read_models import AuditEntry
from labelscan.platform.http.security import require_scope

router = APIRouter()


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


class AlertPage(BaseModel):
    items: list[AlertItem]
    limit: int
    offset: int


@router.get("/v1/alerts", response_model=AlertPage)
def list_alerts(
    request: Request,
    state: str | None = Query(None),
    alert_type: str | None = Query(None),
    severity: str | None = Query(None),
    batch_id: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _principal=Depends(require_scope("haccp:read")),
    engine: Engine = Depends(get_engine),
) -> AlertPage:
    conds, params = [], {"limit": limit, "offset": offset}
    for col, val in (
        ("state", state),
        ("alert_type", alert_type),
        ("severity", severity),
        ("batch_id", batch_id),
    ):
        if val is not None:
            conds.append(f"a.{col} = :{col}")
            params[col] = val
    where = ("WHERE " + " AND ".join(conds)) if conds else ""

    sql = text(
        "SELECT a.id::text AS id, a.batch_id::text AS batch_id, a.alert_type, a.severity, a.state, "
        "a.control_plan_version, a.detail, a.created_at::text AS created_at, a.updated_at::text AS updated_at, "
        "au.actor_id::text AS au_actor, au.action AS au_action, au.occurred_at::text AS au_occurred "
        "FROM haccp.alert a "
        "LEFT JOIN LATERAL (SELECT actor_id, action, occurred_at FROM audit.audit_log "
        "                   WHERE subject_id = a.id ORDER BY occurred_at DESC LIMIT 1) au ON true "
        f"{where} ORDER BY a.created_at DESC LIMIT :limit OFFSET :offset"
    )
    with engine.connect() as c:
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
        )
        for r in rows
    ]
    return AlertPage(items=items, limit=limit, offset=offset)
