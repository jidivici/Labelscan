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
from collections import Counter
from uuid import UUID

import sqlalchemy.exc
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    Path,
    Request,
    Response,
    UploadFile,
    status,
)
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.exceptions import HTTPException as StarletteHTTPException

from labelscan.business_profiles import trade_profile
from labelscan.contexts.ingestion.adapters.http.schemas import IngestionAcceptedResponse
from labelscan.contexts.ingestion.application.confirm_ingestion import (
    ConfirmIngestion,
    ConfirmIngestionCommand,
)
from labelscan.contexts.ingestion.application.confirm_ingestion import (
    IngestionNotFound as ConfirmIngestionNotFound,
)
from labelscan.contexts.ingestion.application.finalize_review import (
    FinalizeReview,
    FinalizeReviewCommand,
    IncompleteReviewFields,
    InvalidReviewFields,
    ReviewIdempotencyConflict,
    ReviewNotAllowed,
    ReviewNotFound,
)
from labelscan.contexts.ingestion.application.override_field import (
    FieldIdempotencyConflict,
    FieldNotEditable,
    IngestionNotFound,
    OverrideField,
    OverrideFieldCommand,
    UnknownField,
)
from labelscan.contexts.ingestion.application.ports import ConfirmNotAllowed
from labelscan.contexts.ingestion.application.retry_extraction import (
    ExtractionRetryNotAllowed,
    ExtractionRetryNotFound,
    RetryExtraction,
    RetryExtractionCommand,
)
from labelscan.contexts.ingestion.application.submit_ingestion import (
    IngestionIdempotencyConflict,
    SubmitIngestion,
    SubmitIngestionCommand,
)
from labelscan.contexts.ingestion.domain.input_validation import (
    validate_barcode_raw,
    validate_client_captured_at,
    validate_idempotency_key,
)
from labelscan.platform.http.access import access_context_for_principal
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.security import Principal, require_scope
from labelscan.platform.image_validation import InvalidImage, sanitize_image

router = APIRouter()

_ACCEPTED_MEDIA = {"image/jpeg", "image/png", "image/webp"}
_MAX_BYTES = 10 * 1024 * 1024
_READ_CHUNK_BYTES = 64 * 1024
_INGESTION_FORM_FIELDS = frozenset(
    {"image", "barcode_raw", "client_captured_at"}
)


_DEFAULT_USE_CASE: SubmitIngestion | None = None
# Guards the lazy build below: FastAPI runs sync endpoints in a threadpool, so
# concurrent first requests could otherwise each build a use case (and a DB
# engine), leaving one orphaned. Double-checked locking keeps the build once.
_USE_CASE_LOCK = threading.Lock()


def _bounded_idempotency_key(value: str | None, *, required: bool) -> str | None:
    try:
        return validate_idempotency_key(value, required=required)
    except ValueError as exc:
        raise ApiError("VALIDATION_ERROR", str(exc))


def _canonical_uuid(value: str, *, label: str) -> str:
    try:
        return str(UUID(value))
    except (ValueError, AttributeError) as exc:
        raise ApiError("VALIDATION_ERROR", f"{label} must be a UUID") from exc


def get_submit_ingestion() -> SubmitIngestion:
    # Composition seam — overridden in tests. Built lazily from this context's own
    # adapters + platform (never imports the app layer, preserving the inward
    # dependency direction). Cached so the engine is built once.
    global _DEFAULT_USE_CASE
    if _DEFAULT_USE_CASE is None:
        with _USE_CASE_LOCK:
            if _DEFAULT_USE_CASE is None:
                from labelscan.contexts.ingestion.adapters.sql_ingestion_repository import (
                    SqlIngestionRepository,
                )
                from labelscan.platform.db.engine import make_engine
                from labelscan.platform.storage_factory import build_raw_store

                _DEFAULT_USE_CASE = SubmitIngestion(
                    build_raw_store(), SqlIngestionRepository(make_engine())
                )
    return _DEFAULT_USE_CASE


_DEFAULT_RETRY_USE_CASE: RetryExtraction | None = None
_RETRY_USE_CASE_LOCK = threading.Lock()


def get_retry_extraction() -> RetryExtraction:
    global _DEFAULT_RETRY_USE_CASE
    if _DEFAULT_RETRY_USE_CASE is None:
        with _RETRY_USE_CASE_LOCK:
            if _DEFAULT_RETRY_USE_CASE is None:
                from labelscan.contexts.ingestion.adapters.sql_extraction_retry_repository import (
                    SqlExtractionRetryRepository,
                )
                from labelscan.platform.db.engine import make_engine

                _DEFAULT_RETRY_USE_CASE = RetryExtraction(
                    SqlExtractionRetryRepository(make_engine())
                )
    return _DEFAULT_RETRY_USE_CASE


async def _require_strict_ingestion_form(request: Request) -> None:
    """Reject ambiguous multipart inputs before FastAPI selects field values.

    Starlette's form object deliberately preserves duplicate entries, while a
    normal mapping lookup does not.  Inspecting ``multi_items`` prevents an
    attacker from smuggling a second value whose selection could differ between
    the API gateway, framework and application.
    """

    try:
        form = await request.form(
            max_files=2,
            max_fields=3,
            max_part_size=128 * 1024,
        )
    except StarletteHTTPException as exc:
        raise ApiError("VALIDATION_ERROR", "invalid multipart form") from exc
    counts = Counter(name for name, _value in form.multi_items())
    unknown = sorted(set(counts) - _INGESTION_FORM_FIELDS)
    if unknown:
        raise ApiError("VALIDATION_ERROR", "multipart form contains unknown fields")
    if any(count != 1 for count in counts.values()):
        raise ApiError("VALIDATION_ERROR", "multipart form contains duplicate fields")


@router.post(
    "/v1/ingestions",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=IngestionAcceptedResponse,
)
def submit_ingestion(
    request: Request,
    response: Response,
    _strict_form: None = Depends(_require_strict_ingestion_form),
    image: UploadFile = File(...),
    barcode_raw: str | None = Form(None, max_length=128),
    client_captured_at: str | None = Form(None, max_length=64),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
    principal: Principal = Depends(require_scope("ingestion:write")),
    use_case: SubmitIngestion = Depends(get_submit_ingestion),
) -> IngestionAcceptedResponse:
    del _strict_form
    idempotency_key = _bounded_idempotency_key(idempotency_key, required=True)
    try:
        barcode_raw = validate_barcode_raw(barcode_raw)
        client_captured_at = validate_client_captured_at(client_captured_at)
    except ValueError as exc:
        raise ApiError("VALIDATION_ERROR", str(exc))

    media_type = (image.content_type or "").split(";")[0].strip()
    if media_type not in _ACCEPTED_MEDIA:
        raise ApiError(
            "UNSUPPORTED_MEDIA_TYPE", f"media type '{media_type}' is not accepted"
        )

    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = image.file.read(_READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > _MAX_BYTES:
            raise ApiError(
                "PAYLOAD_TOO_LARGE", "image exceeds the configured size limit"
            )
        chunks.append(chunk)
    data = b"".join(chunks)
    if not data:
        raise ApiError("VALIDATION_ERROR", "empty image payload")
    try:
        sanitized = sanitize_image(data, media_type)
    except InvalidImage as exc:
        raise ApiError("VALIDATION_ERROR", str(exc))

    access = access_context_for_principal(principal)
    portal_id = getattr(principal, "business_portal_id", None)
    if portal_id is None and len(access.business_portal_ids) == 1:
        portal_id = next(iter(access.business_portal_ids))
    profile = trade_profile(getattr(principal, "trade_code", None))
    command = SubmitIngestionCommand(
        image_bytes=data,
        content_type=media_type,
        sanitized_image_bytes=sanitized.content,
        sanitized_content_type=sanitized.media_type,
        actor_id=principal.actor_id,  # audit context: who
        correlation_id=request.state.correlation_id,  # audit context: correlation
        trace_id=request.state.trace_id,  # audit context: trace
        principal=principal.principal,  # idempotency scope
        idempotency_key=idempotency_key,
        barcode_raw=barcode_raw,
        client_captured_at=client_captured_at,
        store_code=principal.store_code,
        organization_id=principal.organization_id,
        store_id=principal.store_id,
        business_portal_id=portal_id,
        trade_code_snapshot=profile.code,
        trade_profile_version=profile.version,
    )

    try:
        result = use_case(command)
    except IngestionIdempotencyConflict:
        raise ApiError(
            "IDEMPOTENCY_KEY_CONFLICT",
            "Idempotency-Key was already used for a different ingestion payload",
        )
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


class RetryExtractionResponse(BaseModel):
    ingestion_id: str
    status: str
    replayed: bool


@router.post(
    "/v1/ingestions/{ingestion_id}/retry",
    response_model=RetryExtractionResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def retry_extraction(
    request: Request,
    ingestion_id: str = Path(min_length=1, max_length=128),
    principal: Principal = Depends(require_scope("ingestion:write")),
    use_case: RetryExtraction = Depends(get_retry_extraction),
) -> RetryExtractionResponse:
    """Queue a fresh extraction attempt against the already-stored source photo."""

    ingestion_id = _canonical_uuid(ingestion_id, label="ingestion_id")
    if not principal.organization_id:
        raise ApiError("UNAUTHENTICATED", "organization context is missing")
    try:
        result = use_case(
            RetryExtractionCommand(
                ingestion_id=ingestion_id,
                organization_id=principal.organization_id,
                actor_id=principal.actor_id,
                correlation_id=request.state.correlation_id,
                trace_id=request.state.trace_id,
                access=access_context_for_principal(principal),
            )
        )
    except ExtractionRetryNotFound:
        raise ApiError("NOT_FOUND", f"ingestion {ingestion_id} not found")
    except ExtractionRetryNotAllowed as exc:
        raise ApiError(
            "INGESTION_NOT_RETRYABLE",
            f"ingestion is '{exc.status}' — only a failed analysis can be retried",
        )
    except (sqlalchemy.exc.OperationalError, sqlalchemy.exc.InterfaceError, OSError):
        raise ApiError("DEPENDENCY_UNAVAILABLE", "storage unavailable; retry")
    return RetryExtractionResponse(
        ingestion_id=result.ingestion_id,
        status=result.status,
        replayed=result.replayed,
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
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    value: str | None = Field(None, max_length=512)
    note: str | None = Field(None, max_length=2000)
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
    request: Request,
    body: OverrideFieldRequest,
    ingestion_id: str = Path(min_length=1, max_length=128),
    field_name: str = Path(min_length=1, max_length=128),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
    principal: Principal = Depends(require_scope("extraction:review")),
    use_case: OverrideField = Depends(get_override_field),
) -> OverriddenFieldResponse:
    ingestion_id = _canonical_uuid(ingestion_id, label="ingestion_id")
    idempotency_key = _bounded_idempotency_key(idempotency_key, required=False)
    command = OverrideFieldCommand(
        ingestion_id=ingestion_id,
        field_name=field_name,
        value=body.value,
        note=body.note,
        actor_id=principal.actor_id,  # audit context + human provenance: who validated
        correlation_id=request.state.correlation_id,
        trace_id=request.state.trace_id,
        organization_id=principal.organization_id,
        # Server-side retry dedup (P3): a repeat of this key (per actor) replays the
        # original outcome instead of appending another run.
        idempotency_key=idempotency_key,
        force_gs1=body.force_gs1,
        access=access_context_for_principal(principal),
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
    except FieldIdempotencyConflict:
        raise ApiError(
            "IDEMPOTENCY_KEY_CONFLICT",
            "Idempotency-Key was already used for a different field override",
        )
    except ValueError as exc:
        raise ApiError("VALIDATION_ERROR", str(exc))
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
    request: Request,
    ingestion_id: str = Path(min_length=1, max_length=128),
    principal: Principal = Depends(require_scope("extraction:review")),
    use_case: ConfirmIngestion = Depends(get_confirm_ingestion),
) -> ConfirmIngestionResponse:
    ingestion_id = _canonical_uuid(ingestion_id, label="ingestion_id")
    command = ConfirmIngestionCommand(
        ingestion_id=ingestion_id,
        actor_id=principal.actor_id,  # audit: who reviewed
        correlation_id=request.state.correlation_id,
        trace_id=request.state.trace_id,
        organization_id=principal.organization_id,
        access=access_context_for_principal(principal),
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


# ── Enterprise sync: complete trade-profile review + confirmation in one commit ─

_DEFAULT_FINALIZE_REVIEW: FinalizeReview | None = None
_FINALIZE_REVIEW_LOCK = threading.Lock()


def get_finalize_review() -> FinalizeReview:
    global _DEFAULT_FINALIZE_REVIEW
    if _DEFAULT_FINALIZE_REVIEW is None:
        with _FINALIZE_REVIEW_LOCK:
            if _DEFAULT_FINALIZE_REVIEW is None:
                from labelscan.contexts.ingestion.adapters.sql_review_repository import (
                    SqlReviewRepository,
                )
                from labelscan.platform.db.engine import make_engine

                _DEFAULT_FINALIZE_REVIEW = FinalizeReview(
                    SqlReviewRepository(make_engine())
                )
    return _DEFAULT_FINALIZE_REVIEW


class FinalizeReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    fields: dict[str, str | None]
    note: str | None = Field(None, max_length=2000)
    photo_rotation_degrees: int = Field(0)
    photo_base_rotation_degrees: int = Field(-90)

    @model_validator(mode="after")
    def values_are_bounded(self):
        if self.photo_rotation_degrees not in (0, 180):
            raise ValueError("photo rotation must be 0 or 180 degrees")
        if self.photo_base_rotation_degrees not in (-90, 0):
            raise ValueError("photo base rotation must be -90 or 0 degrees")
        if any(
            value is not None and len(value) > 512 for value in self.fields.values()
        ):
            raise ValueError("review field values must be at most 512 characters")
        return self


class FinalizeReviewResponse(BaseModel):
    ingestion_id: str
    run_id: str
    status: str
    replayed: bool


@router.post(
    "/v1/ingestions/{ingestion_id}/reviews",
    response_model=FinalizeReviewResponse,
)
def finalize_review(
    request: Request,
    body: FinalizeReviewRequest,
    ingestion_id: str = Path(min_length=1, max_length=128),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
    principal: Principal = Depends(require_scope("extraction:review")),
    use_case: FinalizeReview = Depends(get_finalize_review),
) -> FinalizeReviewResponse:
    ingestion_id = _canonical_uuid(ingestion_id, label="ingestion_id")
    idempotency_key = _bounded_idempotency_key(idempotency_key, required=True)
    if not principal.organization_id:
        raise ApiError("UNAUTHENTICATED", "organization context is missing")
    try:
        result = use_case(
            FinalizeReviewCommand(
                ingestion_id=ingestion_id,
                organization_id=principal.organization_id,
                fields=body.fields,
                note=body.note,
                photo_rotation_degrees=body.photo_rotation_degrees,
                photo_base_rotation_degrees=body.photo_base_rotation_degrees,
                idempotency_key=idempotency_key,
                actor_id=principal.actor_id,
                correlation_id=request.state.correlation_id,
                trace_id=request.state.trace_id,
                access=access_context_for_principal(principal),
            )
        )
    except InvalidReviewFields as exc:
        detail_parts = []
        if exc.missing:
            detail_parts.append(f"missing: {', '.join(sorted(exc.missing))}")
        if exc.extra:
            detail_parts.append(f"unknown: {', '.join(sorted(exc.extra))}")
        raise ApiError("VALIDATION_ERROR", "; ".join(detail_parts))
    except IncompleteReviewFields as exc:
        raise ApiError(
            "VALIDATION_ERROR",
            f"empty: {', '.join(sorted(exc.fields))}",
        )
    except ReviewNotFound:
        raise ApiError("NOT_FOUND", f"ingestion {ingestion_id} not found")
    except ReviewNotAllowed as exc:
        raise ApiError(
            "INGESTION_NOT_CONFIRMABLE",
            f"ingestion is '{exc.status}' — it is not ready for final review",
        )
    except ReviewIdempotencyConflict:
        raise ApiError(
            "IDEMPOTENCY_KEY_CONFLICT",
            "Idempotency-Key was already used for a different final review",
        )
    except ValueError as exc:
        raise ApiError("VALIDATION_ERROR", str(exc))
    except (sqlalchemy.exc.OperationalError, sqlalchemy.exc.InterfaceError, OSError):
        raise ApiError("DEPENDENCY_UNAVAILABLE", "storage unavailable; retry")

    return FinalizeReviewResponse(
        ingestion_id=result.ingestion_id,
        run_id=result.run_id,
        status=result.status,
        replayed=result.replayed,
    )
