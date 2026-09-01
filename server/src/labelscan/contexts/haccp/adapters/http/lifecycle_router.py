"""Alert lifecycle HTTP endpoints (adapter).

Thin: parses the path id, assembles the audit context (actor from the principal,
correlation/trace from middleware), and calls the application service ONLY. It
contains NO transition logic — valid transitions are enforced in the domain, and
the audit row is co-committed by the alert's DB trigger. Invalid transitions and
missing alerts are mapped to the BACKEND §5.2 problem+json codes.
"""

from __future__ import annotations

import unicodedata
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Request
from pydantic import BaseModel

from labelscan.contexts.haccp.application.alert_service import (
    AlertLifecycleService,
    AlertNotFound,
    AuditContext,
)
from labelscan.contexts.haccp.domain.alert import InvalidAlertTransition
from labelscan.platform.http.access import access_context_for_principal
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.security import Principal, require_scope

router = APIRouter()

_SERVICE: AlertLifecycleService | None = None


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
        raise ValueError("alert_id must be a canonical UUID string")
    normalized = unicodedata.normalize("NFC", value)
    if normalized != value or any(
        unicodedata.category(character) in {"Cc", "Cf", "Cs"}
        or unicodedata.bidirectional(character) in _BIDI_CONTROL_CLASSES
        for character in value
    ):
        raise ValueError("alert_id must be a canonical UUID string")
    try:
        parsed = UUID(value)
    except ValueError as exc:
        raise ValueError("alert_id must be a canonical UUID string") from exc
    if value != str(parsed):
        raise ValueError("alert_id must use canonical lowercase UUID form")
    return parsed


def _reject_query_parameters(request: Request) -> None:
    if request.query_params:
        raise ApiError("VALIDATION_ERROR", "this endpoint accepts no query parameters")


def get_alert_service() -> AlertLifecycleService:
    # Composition seam — overridden in tests. Built from this context's own
    # adapter + platform (no app import). Cached.
    global _SERVICE
    if _SERVICE is None:
        from labelscan.contexts.haccp.adapters.sql_alert_repository import (
            SqlAlertRepository,
        )
        from labelscan.platform.db.engine import make_engine

        _SERVICE = AlertLifecycleService(SqlAlertRepository(make_engine()))
    return _SERVICE


class AlertStateResponse(BaseModel):
    alert_id: str
    state: str


def _audit(request: Request, principal: Principal) -> AuditContext:
    return AuditContext(
        actor_id=principal.actor_id,
        correlation_id=request.state.correlation_id,
        trace_id=request.state.trace_id,
        access=access_context_for_principal(principal),
    )


@router.post("/v1/alerts/{alert_id}/acknowledge", response_model=AlertStateResponse)
def acknowledge_alert(
    request: Request,
    alert_id: str = Path(min_length=36, max_length=36, pattern=_CANONICAL_UUID_PATTERN),
    principal: Principal = Depends(require_scope("alert:ack")),
    service: AlertLifecycleService = Depends(get_alert_service),
) -> AlertStateResponse:
    _reject_query_parameters(request)
    alert_id_text = str(_parse_canonical_uuid(alert_id))
    try:
        new_state = service.acknowledge(alert_id_text, _audit(request, principal))
    except AlertNotFound:
        raise ApiError("NOT_FOUND", f"alert {alert_id_text} not found")
    except InvalidAlertTransition as exc:
        raise ApiError("ALERT_INVALID_TRANSITION", str(exc))
    return AlertStateResponse(alert_id=alert_id_text, state=new_state.value)


@router.post("/v1/alerts/{alert_id}/resolve", response_model=AlertStateResponse)
def resolve_alert(
    request: Request,
    alert_id: str = Path(min_length=36, max_length=36, pattern=_CANONICAL_UUID_PATTERN),
    principal: Principal = Depends(require_scope("alert:resolve")),
    service: AlertLifecycleService = Depends(get_alert_service),
) -> AlertStateResponse:
    _reject_query_parameters(request)
    alert_id_text = str(_parse_canonical_uuid(alert_id))
    try:
        new_state = service.resolve(alert_id_text, _audit(request, principal))
    except AlertNotFound:
        raise ApiError("NOT_FOUND", f"alert {alert_id_text} not found")
    except InvalidAlertTransition as exc:
        raise ApiError("ALERT_INVALID_TRANSITION", str(exc))
    return AlertStateResponse(alert_id=alert_id_text, state=new_state.value)
