"""HTTP adapter for the SubmitIngestion (SubmitCapture) use case.

ADAPTER ONLY — no business logic, no new behavior. It:
  * validates transport concerns (required Idempotency-Key, media type, size),
  * establishes the audit context VALUES (actor from auth, correlation/trace from
    middleware) by putting them in the command — the use case's repository then
    sets them transactionally, so no audited write ever runs without context,
  * calls the existing use case (which stores raw before ack, enqueues the
    outbox in the same transaction, and returns 202 only after commit),
  * maps results/errors to the response + the BACKEND §5.2 problem+json catalog.

It calls NO external provider and does NOT touch the outbox directly.
"""

from __future__ import annotations

import threading

import sqlalchemy.exc
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    Request,
    Response,
    UploadFile,
    status,
)
from pydantic import BaseModel

from labelscan.contexts.ingestion.adapters.http.schemas import IngestionAcceptedResponse
from labelscan.contexts.ingestion.application.confirm_ingestion import (
    ConfirmIngestion,
    ConfirmIngestionCommand,
)
from labelscan.contexts.ingestion.application.confirm_ingestion import (
    IngestionNotFound as ConfirmIngestionNotFound,
)
from labelscan.contexts.ingestion.application.override_field import (
    FieldNotEditable,
    IngestionNotFound,
    OverrideField,
    OverrideFieldCommand,
    UnknownField,
)
from labelscan.contexts.ingestion.application.ports import ConfirmNotAllowed
from labelscan.contexts.ingestion.application.submit_ingestion import (
    SubmitIngestion,
    SubmitIngestionCommand,
)
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.security import Principal, require_scope

router = APIRouter()

_ACCEPTED_MEDIA = {"image/jpeg", "image/png", "image/webp", "image/heic"}
_MAX_BYTES = 10 * 1024 * 1024


_DEFAULT_USE_CASE: SubmitIngestion | None = None
# Guards the lazy build below: FastAPI runs sync endpoints in a threadpool, so
# concurrent first requests could otherwise each build a use case (and a DB
# engine), leaving one orphaned. Double-checked locking keeps the build once.
_USE_CASE_LOCK = threading.Lock()


def get_submit_ingestion() -> SubmitIngestion:
    # Composition seam — overridden in tests. Built lazily from this context's own
    # adapters + platform (never imports the app layer, preserving the inward
    # dependency direction). Cached so the engine is built once.
    global _DEFAULT_USE_CASE
    if _DEFAULT_USE_CASE is None:
        with _USE_CASE_LOCK:
            if _DEFAULT_USE_CASE is None:
                import os

                from labelscan.contexts.ingestion.adapters.filesystem_raw_store import (
                    FilesystemRawStore,
                )
                from labelscan.contexts.ingestion.adapters.sql_ingestion_repository import (
                    SqlIngestionRepository,
                )
                from labelscan.platform.db.engine import make_engine

                raw_dir = os.environ.get("LABELSCAN_RAW_STORE_DIR")
                if not raw_dir:
                    raise RuntimeError("LABELSCAN_RAW_STORE_DIR is not set")
                _DEFAULT_USE_CASE = SubmitIngestion(
                    FilesystemRawStore(raw_dir), SqlIngestionRepository(make_engine())
                )
    return _DEFAULT_USE_CASE


@router.post(
    "/v1/ingestions",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=IngestionAcceptedResponse,
)
def submit_ingestion(
    request: Request,
    response: Response,
    image: UploadFile = File(...),
    barcode_raw: str | None = Form(None),
    client_captured_at: str | None = Form(None),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
    principal: Principal = Depends(require_scope("ingestion:write")),
    use_case: SubmitIngestion = Depends(get_submit_ingestion),
) -> IngestionAcceptedResponse:
    if not idempotency_key:
        raise ApiError("VALIDATION_ERROR", "Idempotency-Key header is required")

    media_type = (image.content_type or "").split(";")[0].strip()
    if media_type not in _ACCEPTED_MEDIA:
        raise ApiError(
            "UNSUPPORTED_MEDIA_TYPE", f"media type '{media_type}' is not accepted"
        )

    data = image.file.read()
    if not data:
        raise ApiError("VALIDATION_ERROR", "empty image payload")
    if len(data) > _MAX_BYTES:
        raise ApiError("PAYLOAD_TOO_LARGE", "image exceeds the configured size limit")

    command = SubmitIngestionCommand(
        image_bytes=data,
        content_type=media_type,
        actor_id=principal.actor_id,  # audit context: who
        correlation_id=request.state.correlation_id,  # audit context: correlation
        trace_id=request.state.trace_id,  # audit context: trace
        principal=principal.principal,  # idempotency scope
        barcode_raw=barcode_raw,
        client_captured_at=client_captured_at,
    )

    try:
        result = use_case(command)
    except ValueError as exc:  # defence in depth: the use case re-validates
        raise ApiError("VALIDATION_ERROR", str(exc))
    except (sqlalchemy.exc.OperationalError, sqlalchemy.exc.InterfaceError, OSError):
        # object store / DB unavailable — fail closed so the durable client queue
        # retries with the same Idempotency-Key (raw-before-ack / AUDIT R9).
        raise ApiError(
            "DEPENDENCY_UNAVAILABLE",
            "storage unavailable; retry with the same Idempotency-Key",
        )

    if result.replayed:
        response.headers["Idempotency-Replayed"] = "true"
    return IngestionAcceptedResponse(
        ingestion_id=result.ingestion_id,
        status=result.status,
        replayed=result.replayed,
        correlation_id=request.state.correlation_id,
    )


# ── Capability 4: human override of one extracted field (HITL, audit §4.2) ──────────

_DEFAULT_OVERRIDE_USE_CASE: OverrideField | None = None
_OVERRIDE_LOCK = threading.Lock()


def get_override_field() -> OverrideField:
    # Composition seam (overridden in tests). Lazy, same double-checked pattern as
    # get_submit_ingestion so the engine is built once and the app layer is not imported.
    global _DEFAULT_OVERRIDE_USE_CASE
    if _DEFAULT_OVERRIDE_USE_CASE is None:
        with _OVERRIDE_LOCK:
            if _DEFAULT_OVERRIDE_USE_CASE is None:
                from labelscan.contexts.ingestion.adapters.sql_field_override_repository import (
                    SqlFieldOverrideRepository,
                )
                from labelscan.platform.db.engine import make_engine

                _DEFAULT_OVERRIDE_USE_CASE = OverrideField(
                    SqlFieldOverrideRepository(make_engine())
                )
    return _DEFAULT_OVERRIDE_USE_CASE


class OverrideFieldRequest(BaseModel):
    value: str | None = None  # null/blank => the reviewer cleared the field
    note: str | None = None
    # Explicit acknowledgement required to override a GS1-owned (barcode-derived)
    # field; without it those fields stay 409 FIELD_NOT_EDITABLE (back-compat).
    force_gs1: bool = False


class OverriddenFieldResponse(BaseModel):
    ingestion_id: str
    run_id: str
    field_name: str
    value: str | None
    validation_status: str
    source: str
    combined_confidence: float
    confidence_band: str
    replayed: bool


@router.patch(
    "/v1/ingestions/{ingestion_id}/fields/{field_name}",
    response_model=OverriddenFieldResponse,
)
def override_field(
    ingestion_id: str,
    field_name: str,
    request: Request,
    body: OverrideFieldRequest,
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
    principal: Principal = Depends(require_scope("extraction:review")),
    use_case: OverrideField = Depends(get_override_field),
) -> OverriddenFieldResponse:
    command = OverrideFieldCommand(
        ingestion_id=ingestion_id,
        field_name=field_name,
        value=body.value,
        note=body.note,
        actor_id=principal.actor_id,  # audit context + human provenance: who validated
        correlation_id=request.state.correlation_id,
        trace_id=request.state.trace_id,
        # Server-side retry dedup (P3): a repeat of this key (per actor) replays the
        # original outcome instead of appending another run.
        idempotency_key=idempotency_key,
        force_gs1=body.force_gs1,
    )
    try:
        result = use_case(command)
    except UnknownField:
        raise ApiError("VALIDATION_ERROR", f"unknown field '{field_name}'")
    except FieldNotEditable:
        raise ApiError(
            "FIELD_NOT_EDITABLE",
            f"field '{field_name}' is barcode-derived (GS1); set force_gs1 to override",
        )
    except IngestionNotFound:
        raise ApiError(
            "NOT_FOUND",
            f"no extraction run to override for ingestion {ingestion_id}",
        )
    except (sqlalchemy.exc.OperationalError, sqlalchemy.exc.InterfaceError, OSError):
        raise ApiError("DEPENDENCY_UNAVAILABLE", "storage unavailable; retry")

    return OverriddenFieldResponse(
        ingestion_id=ingestion_id,
        run_id=result.run_id,
        field_name=result.field_name,
        value=result.value,
        validation_status=result.validation_status,
        source=result.source,
        combined_confidence=result.combined_confidence,
        confidence_band=result.confidence_band,
        replayed=result.replayed,
    )


# ── P3: reviewer confirmation — finalize the review (terminal 'confirmed') ──────────

_DEFAULT_CONFIRM_USE_CASE: ConfirmIngestion | None = None
_CONFIRM_LOCK = threading.Lock()


def get_confirm_ingestion() -> ConfirmIngestion:
    # Composition seam (overridden in tests) — same lazy double-checked pattern.
    global _DEFAULT_CONFIRM_USE_CASE
    if _DEFAULT_CONFIRM_USE_CASE is None:
        with _CONFIRM_LOCK:
            if _DEFAULT_CONFIRM_USE_CASE is None:
                from labelscan.contexts.ingestion.adapters.sql_confirm_repository import (
                    SqlConfirmRepository,
                )
                from labelscan.platform.db.engine import make_engine

                _DEFAULT_CONFIRM_USE_CASE = ConfirmIngestion(
                    SqlConfirmRepository(make_engine())
                )
    return _DEFAULT_CONFIRM_USE_CASE


class ConfirmIngestionResponse(BaseModel):
    ingestion_id: str
    status: str  # 'confirmed'
    replayed: bool  # True => it was already confirmed (idempotent repeat)


@router.post(
    "/v1/ingestions/{ingestion_id}/confirm",
    response_model=ConfirmIngestionResponse,
)
def confirm_ingestion(
    ingestion_id: str,
    request: Request,
    principal: Principal = Depends(require_scope("extraction:review")),
    use_case: ConfirmIngestion = Depends(get_confirm_ingestion),
) -> ConfirmIngestionResponse:
    command = ConfirmIngestionCommand(
        ingestion_id=ingestion_id,
        actor_id=principal.actor_id,  # audit: who reviewed
        correlation_id=request.state.correlation_id,
        trace_id=request.state.trace_id,
    )
    try:
        result = use_case(command)
    except ConfirmIngestionNotFound:
        raise ApiError("NOT_FOUND", f"ingestion {ingestion_id} not found")
    except ConfirmNotAllowed as exc:
        # Confirming a still-processing or failed ingestion would assert a review
        # that never happened — a state error the client must not retry blindly.
        raise ApiError(
            "INGESTION_NOT_CONFIRMABLE",
            f"ingestion is '{exc.status}' — only a review-ready ingestion can be confirmed",
        )
    except (sqlalchemy.exc.OperationalError, sqlalchemy.exc.InterfaceError, OSError):
        raise ApiError("DEPENDENCY_UNAVAILABLE", "storage unavailable; retry")

    return ConfirmIngestionResponse(
        ingestion_id=result.ingestion_id,
        status=result.status,
        replayed=result.replayed,
    )
