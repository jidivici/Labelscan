"""Portal-scoped hygiene board, independent of ingestion and catalog state."""

from datetime import date, datetime
from typing import Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.haccp.domain.hygiene import tasks_for_trade
from labelscan.platform.db.tenant_context import set_tenant_context
from labelscan.platform.http.access import access_context_for_principal
from labelscan.platform.http.deps import get_engine
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.security import Principal, require_scope

router = APIRouter(prefix="/v1/hygiene")


class CheckInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    day: date
    outcome: Literal["done", "issue", "not_applicable"]
    notes: str = Field(min_length=1, max_length=4000)
    request_id: UUID


class TaskView(BaseModel):
    code: str
    title: str
    instructions: str
    source_pages: str
    frequency: str
    optional: bool
    period_start: date
    outcome: str = "pending"
    notes: str = ""
    recorded_at: datetime | None = None
    actor_id: str | None = None


class Board(BaseModel):
    day: date
    today: date
    portal_name: str
    tasks: list[TaskView]


def _portal(conn, principal, portal_id):
    if not principal.organization_id:
        raise ApiError("FORBIDDEN", "organization required")
    set_tenant_context(conn, principal.organization_id)
    row = (
        conn.execute(
            text("""
        SELECT p.*, o.timezone FROM identity.business_portal p
        JOIN identity.organization o ON o.id = p.organization_id
        JOIN identity.store s ON s.id = p.store_id
        WHERE p.id = :portal AND p.organization_id = :org
          AND p.active AND o.active AND s.active
    """),
            {"portal": str(portal_id), "org": principal.organization_id},
        )
        .mappings()
        .first()
    )
    if not row or not access_context_for_principal(principal).permits(
        organization_id=str(row["organization_id"]),
        store_id=str(row["store_id"]),
        business_portal_id=str(row["id"]),
    ):
        raise ApiError("NOT_FOUND", "portal not found")
    return row


def _board(conn, principal, portal, day):
    tasks = tasks_for_trade(portal["profession_code"])
    rows = (
        conn.execute(
            text("""
        SELECT * FROM haccp.hygiene_check
        WHERE organization_id = :org AND business_portal_id = :portal
          AND period_start <= :day AND performed_day <= :day
          AND period_start >= :start
        ORDER BY recorded_at DESC, id DESC
    """),
            {
                "org": principal.organization_id,
                "portal": str(portal["id"]),
                "day": day,
                "start": min((t.period(day) for t in tasks), default=day),
            },
        )
        .mappings()
        .all()
    )
    views = []
    for task in tasks:
        last = next(
            (
                r
                for r in rows
                if r["task_code"] == task.code and r["period_start"] == task.period(day)
            ),
            None,
        )
        views.append(
            TaskView(
                **task.__dict__,
                period_start=task.period(day),
                **(
                    {
                        "outcome": last["outcome"],
                        "notes": last["notes"],
                        "recorded_at": last["recorded_at"],
                        "actor_id": str(last["actor_id"]),
                    }
                    if last
                    else {}
                ),
            )
        )
    return Board(
        day=day,
        today=datetime.now(ZoneInfo(portal["timezone"])).date(),
        portal_name=portal["name"],
        tasks=views,
    )


@router.get("/{portal_id}", response_model=Board)
def get_board(
    portal_id: UUID,
    day: date | None = None,
    principal: Principal = Depends(require_scope("haccp:read")),
    engine: Engine = Depends(get_engine),
):
    with engine.begin() as conn:
        portal = _portal(conn, principal, portal_id)
        day = day or datetime.now(ZoneInfo(portal["timezone"])).date()
        return _board(conn, principal, portal, day)


@router.post("/{portal_id}/{task_code}", response_model=Board)
def record_check(
    portal_id: UUID,
    task_code: str,
    body: CheckInput,
    principal: Principal = Depends(require_scope("extraction:review")),
    engine: Engine = Depends(get_engine),
):
    with engine.begin() as conn:
        portal = _portal(conn, principal, portal_id)
        today = datetime.now(ZoneInfo(portal["timezone"])).date()
        if body.day != today:
            raise ApiError("VALIDATION_ERROR", "only today's checks can be recorded")
        task = next(
            (
                t
                for t in tasks_for_trade(portal["profession_code"])
                if t.code == task_code
            ),
            None,
        )
        if not task:
            raise ApiError("NOT_FOUND", "task not found")
        if not body.notes.strip() or (
            body.outcome == "not_applicable" and not task.optional
        ):
            raise ApiError("VALIDATION_ERROR", "measurements or justification required")
        conn.execute(
            text("""
            INSERT INTO haccp.hygiene_check
                (organization_id, business_portal_id, task_code, period_start,
                 performed_day, outcome, notes, actor_id, request_id)
            VALUES (:org, :portal, :task, :period, :day, :outcome, :notes, :actor, :request)
            ON CONFLICT (organization_id, business_portal_id, request_id) DO NOTHING
        """),
            {
                "org": principal.organization_id,
                "portal": str(portal_id),
                "task": task.code,
                "period": task.period(today),
                "day": today,
                "outcome": body.outcome,
                "notes": body.notes.strip(),
                "actor": principal.actor_id,
                "request": str(body.request_id),
            },
        )
        saved = (
            conn.execute(
                text("""
            SELECT task_code, performed_day, outcome, notes, actor_id
            FROM haccp.hygiene_check WHERE organization_id = :org
              AND business_portal_id = :portal AND request_id = :request
        """),
                {
                    "org": principal.organization_id,
                    "portal": str(portal_id),
                    "request": str(body.request_id),
                },
            )
            .mappings()
            .one()
        )
        if (
            saved["task_code"],
            saved["performed_day"],
            saved["outcome"],
            saved["notes"],
            str(saved["actor_id"]),
        ) != (task.code, today, body.outcome, body.notes.strip(), principal.actor_id):
            raise ApiError("IDEMPOTENCY_KEY_CONFLICT", "request id already used")
        return _board(conn, principal, portal, today)
