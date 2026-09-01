"""Read-only endpoints for ingestion + extraction runs (query adapter).

No writes, no domain logic, read connections only. Reflects the append-only
nature: an ingestion exposes ALL its extraction runs (a re-extraction is a new
run, never an overwrite); the latest is marked `is_latest` (a derived read
projection, not a mutation). Fields carry their stored provenance verbatim.

Long-poll (Tier 4): GET /v1/ingestions/{id}?wait=<s>&last_status=<status> holds
the request (bounded, ≤25 s) until the status DIFFERS from last_status, then
returns the normal view — the client learns of raw_stored→ocr_done→terminal
transitions with ~0 discovery latency instead of a ~1 s poll cadence. The wait
probes the status on short-lived connections (never holds a pool slot), and a
sync endpoint thread is held for the duration — acceptable at this app's device
count; LISTEN/NOTIFY (Tier 2) is the upgrade path if that ever changes.
"""

from __future__ import annotations

import re
import time
import unicodedata
from collections import Counter
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import BaseModel, field_validator
from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.ingestion.domain.status import IngestionStatus
from labelscan.platform.db.tenant_context import set_tenant_context
from labelscan.platform.http.access import (
    access_context_for_principal,
    postgres_scope,
)
from labelscan.platform.http.deps import get_engine
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.rate_limit import LimitExceeded, rate_limits
from labelscan.platform.http.read_models import AuditEntry, audit_entries
from labelscan.platform.http.security import Principal, require_scope
from labelscan.platform.observability import get_logger

router = APIRouter()
_log = get_logger("http.security")

# Long-poll bounds: the hold is ALWAYS bounded (a client cannot pin a thread
# indefinitely) and the probe cadence keeps DB load negligible (one indexed
# SELECT status every ~300 ms per waiting client).
_MAX_WAIT_S = 25.0
_PROBE_INTERVAL_S = 0.3
_WAIT_VALUE = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z")
_BIDI_CONTROL_CLASSES = frozenset(
    {"RLE", "LRE", "RLO", "LRO", "PDF", "RLI", "LRI", "FSI", "PDI"}
)
_INGESTION_QUERY_PARAMETERS = frozenset({"wait", "last_status"})
_CANONICAL_UUID_PATTERN = (
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
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
        raise ValueError("resource id is invalid") from exc
    if value != str(parsed):
        raise ValueError("resource id must use canonical lowercase UUID form")
    return parsed


def _parse_wait(value: object) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        parsed = float(value)
    elif isinstance(value, str) and value.isascii() and _WAIT_VALUE.fullmatch(value):
        parsed = float(value)
    else:
        raise ValueError("wait must be a canonical non-negative decimal number")
    return parsed


def _require_query_shape(request: Request, allowed: frozenset[str]) -> None:
    pairs = request.query_params.multi_items()
    keys = [key for key, _ in pairs]
    unknown = sorted(set(keys) - allowed)
    duplicates = sorted(key for key, count in Counter(keys).items() if count > 1)
    if unknown:
        raise ApiError("VALIDATION_ERROR", "unknown query parameter")
    if duplicates:
        raise ApiError("VALIDATION_ERROR", "query parameters must be singular")
    try:
        for key, value in pairs:
            if key == "wait":
                _parse_wait(value)
            elif key == "last_status":
                _safe_query_token(value)
    except ValueError as exc:
        raise ApiError("VALIDATION_ERROR", str(exc)) from exc


def _organization_id(conn, principal: Principal) -> str:
    if principal.organization_id:
        return principal.organization_id
    return str(
        conn.execute(
            text("SELECT id FROM identity.organization WHERE slug = 'labelscan'")
        ).scalar_one()
    )


def clamp_wait(wait: float) -> float:
    """Bound the requested long-poll hold to [0, _MAX_WAIT_S] (never negative,
    never unbounded — an absurd `wait` degrades to the cap, not an error)."""
    if wait < 0:
        return 0.0
    return min(wait, _MAX_WAIT_S)


def _probe_status(
    engine: Engine, ingestion_id: str, principal: Principal
) -> str | None:
    """Cheap status read on a short-lived connection (indexed PK lookup).
    None = ingestion not found (the full view load raises the 404)."""
    with engine.connect() as c:
        organization_id = _organization_id(c, principal)
        set_tenant_context(c, organization_id)
        access = access_context_for_principal(
            principal, default_organization_id=organization_id
        )
        scope, scope_params = postgres_scope(access, alias="ingestion")
        return c.execute(
            text(
                "SELECT ingestion.status FROM ingestion.ingestion AS ingestion "
                "WHERE ingestion.id = :id AND " + scope
            ),
            {
                "id": ingestion_id,
                **scope_params,
            },
        ).scalar_one_or_none()


class RawArtifactView(BaseModel):
    id: str
    artifact_kind: str
    storage_ref: str
    checksum_sha256: str
    occurred_at: str


class RunSummary(BaseModel):
    run_id: str
    attempt_no: int
    outcome: str
    extractor_version: str
    llm_model: str
    ocr_provider: str
    created_at: str
    is_latest: bool


class FieldView(BaseModel):
    field_name: str
    value: str | None
    evidence: list[str]
    # {raw_artifact_id, spans:[{page, offset_start, offset_end}]}
    provenance: dict[str, Any] | None
    source_raw_artifact_id: str | None
    validation_status: str
    warnings: list[str] | None
    llm_confidence: float | None
    ocr_confidence: float | None
    combined_confidence: float
    confidence_band: str
    source: str
    created_at: str

    @field_validator("evidence", mode="before")
    @classmethod
    def absent_evidence_is_an_empty_array(cls, value: Any) -> list[str]:
        # PostgreSQL keeps NULL for its value/evidence integrity constraint; the
        # public extraction contract is stable and always returns a JSON array.
        return [] if value is None else value


class InterimFieldView(BaseModel):
    # Tier 3 wave 2 — a deterministic (regex) preview field written between OCR and
    # LLM. Non-authoritative: surfaced ONLY while no extraction run exists; the
    # reconciled run supersedes it.
    field_name: str
    value: Any
    source: str
    created_at: str


class IngestionView(BaseModel):
    ingestion_id: str
    status: str
    image_ref: str
    checksum_sha256: str
    barcode_raw: str | None
    client_captured_at: str | None
    server_received_at: str
    correlation_id: str
    trace_id: str
    raw_artifacts: list[RawArtifactView]
    extraction_runs: list[RunSummary]
    # The latest run's fields, embedded so a polling client renders the review screen
    # WITHOUT a second GET /extraction-runs round-trip (audit §1.3). None until a run exists.
    latest_fields: list[FieldView] | None = None
    # Wave-2 preview (status ocr_done): present only BEFORE the first run, so a
    # completed/failed extraction can never show a stale preview as definitive.
    interim_fields: list[InterimFieldView] | None = None
    # Explicit machine-readable recovery signal: when extraction produced no usable
    # value, clients must ask for another photo rather than presenting an empty form
    # as a successful scan.
    recapture_required: bool = False
    recapture_reason: str | None = None
    audit: list[AuditEntry]


class ExtractionRunView(BaseModel):
    run_id: str
    ingestion_id: str
    attempt_no: int
    outcome: str
    extractor_version: str
    prompt_version: str
    ocr_provider: str
    llm_model: str
    ocr_raw_ref: str | None
    rule_set_version: str
    created_at: str
    fields: list[FieldView]
    audit: list[AuditEntry]


def _requires_recapture(status: str, fields: list[FieldView] | None) -> bool:
    """True only for a completed review path that yielded zero usable values."""
    if fields is None or status not in {"needs_review", "ocr_skipped_garbage"}:
        return False
    return not any(
        field.value is not None
        and str(field.value).strip()
        and str(field.value).strip().upper() != "NC"
        and field.validation_status not in {"missing", "invalid", "unnormalizable"}
        for field in fields
    )


@router.get("/v1/ingestions/{ingestion_id}", response_model=IngestionView)
def get_ingestion(
    request: Request,
    ingestion_id: str = Path(
        min_length=36, max_length=36, pattern=_CANONICAL_UUID_PATTERN
    ),
    wait: float = Query(
        default=0.0,
        ge=0.0,
        le=_MAX_WAIT_S,
        allow_inf_nan=False,
        description=(
            "Long-poll hold in seconds (Tier 4), bounded to 25. Requires "
            "last_status; the response returns as soon as the status differs "
            "from last_status, or when the hold expires (with the current state)."
        ),
    ),
    last_status: IngestionStatus | None = Query(
        default=None,
        description="The status the client last observed (long-poll baseline).",
    ),
    principal: Principal = Depends(require_scope("ingestion:read")),
    engine: Engine = Depends(get_engine),
) -> IngestionView:
    _require_query_shape(request, _INGESTION_QUERY_PARAMETERS)
    ingestion_id_text = str(_parse_canonical_uuid(ingestion_id))
    last_status_text = last_status.value if last_status is not None else None
    # ── Tier 4 long-poll: bounded server-side wait for a status CHANGE ─────────
    # Both params required to arm the hold (a bare `wait` has no baseline to
    # compare against). A missing ingestion breaks out immediately — the view
    # load below raises the same 404 the plain GET always did.
    wait_s = clamp_wait(wait)
    if wait_s > 0 and last_status_text:
        try:
            rate_limits.acquire_hold(principal.actor_id)
        except LimitExceeded as exc:
            _log.warning(
                "rate_limited",
                extra={
                    "actor_id": principal.actor_id,
                    "rate_limit_scope": exc.scope,
                    "retry_after": exc.retry_after,
                    "path": request.url.path,
                },
            )
            raise ApiError(
                "RATE_LIMITED",
                "long-poll concurrency limit exceeded",
                headers={"Retry-After": str(exc.retry_after)},
            )
        try:
            deadline = time.monotonic() + wait_s
            while True:
                current = _probe_status(engine, ingestion_id_text, principal)
                if current is None or current != last_status_text:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break  # hold expired — return the (unchanged) current state
                time.sleep(min(_PROBE_INTERVAL_S, remaining))
        finally:
            rate_limits.release_hold(principal.actor_id)

    with engine.connect() as c:
        organization_id = _organization_id(c, principal)
        set_tenant_context(c, organization_id)
        access = access_context_for_principal(
            principal, default_organization_id=organization_id
        )
        scope, scope_params = postgres_scope(access, alias="ingestion")
        row = (
            c.execute(
                text(
                    "SELECT id::text AS id, status, image_ref, checksum_sha256, barcode_raw, "
                    "client_captured_at::text AS cca, server_received_at::text AS sra, "
                    "correlation_id, trace_id FROM ingestion.ingestion AS ingestion "
                    "WHERE ingestion.id = :id AND " + scope
                ),
                {
                    "id": ingestion_id_text,
                    **scope_params,
                },
            )
            .mappings()
            .first()
        )
        if row is None:
            raise ApiError("NOT_FOUND", f"ingestion {ingestion_id_text} not found")
        arts = (
            c.execute(
                text(
                    "SELECT id::text AS id, artifact_kind, storage_ref, checksum_sha256, "
                    "occurred_at::text AS occurred_at FROM ingestion.raw_artifact "
                    "WHERE ingestion_id = :id ORDER BY occurred_at"
                ),
                {"id": ingestion_id_text},
            )
            .mappings()
            .all()
        )
        runs = (
            c.execute(
                text(
                    "SELECT id::text AS run_id, attempt_no, outcome, extractor_version, llm_model, "
                    "ocr_provider, created_at::text AS created_at FROM ingestion.extraction_run "
                    "WHERE ingestion_id = :id ORDER BY attempt_no"
                ),
                {"id": ingestion_id_text},
            )
            .mappings()
            .all()
        )
        audit = audit_entries(c, ingestion_id_text)

        # Latest run's fields, embedded so the polling client renders Review without a 2nd
        # round-trip (§1.3). Empty until a run exists (during polling), so the per-poll
        # payload stays light; only the terminal poll carries the fields.
        latest_run_id = (
            max(runs, key=lambda r: r["attempt_no"])["run_id"] if runs else None
        )
        # Wave-2 preview (Tier 3): only queried while NO run exists — once a run has
        # landed (or failed) the preview is superseded and never surfaced again.
        interim_fields = None
        if latest_run_id is None:
            interim_rows = (
                c.execute(
                    text(
                        "SELECT field_name, value, source, created_at::text AS created_at "
                        "FROM ingestion.interim_field WHERE ingestion_id = :id "
                        "ORDER BY field_name"
                    ),
                    {"id": ingestion_id_text},
                )
                .mappings()
                .all()
            )
            if interim_rows:
                interim_fields = [InterimFieldView(**r) for r in interim_rows]

        latest_fields = None
        if latest_run_id is not None:
            field_rows = (
                c.execute(
                    text(
                        "SELECT field_name, value, evidence, provenance, "
                        "source_raw_artifact_id::text AS source_raw_artifact_id, "
                        "validation_status, warnings, llm_confidence, ocr_confidence, "
                        "combined_confidence, confidence_band, source, "
                        "created_at::text AS created_at FROM ingestion.extracted_field "
                        "WHERE extraction_run_id = :rid ORDER BY field_name"
                    ),
                    {"rid": latest_run_id},
                )
                .mappings()
                .all()
            )
            latest_fields = [FieldView(**f) for f in field_rows]

    max_attempt = max((r["attempt_no"] for r in runs), default=None)
    recapture_required = _requires_recapture(row["status"], latest_fields)
    return IngestionView(
        ingestion_id=row["id"],
        status=row["status"],
        image_ref=row["image_ref"],
        checksum_sha256=row["checksum_sha256"],
        barcode_raw=row["barcode_raw"],
        client_captured_at=row["cca"],
        server_received_at=row["sra"],
        correlation_id=row["correlation_id"],
        trace_id=row["trace_id"],
        raw_artifacts=[RawArtifactView(**a) for a in arts],
        extraction_runs=[
            RunSummary(**r, is_latest=(r["attempt_no"] == max_attempt)) for r in runs
        ],
        latest_fields=latest_fields,
        interim_fields=interim_fields,
        recapture_required=recapture_required,
        recapture_reason="no_field_extracted" if recapture_required else None,
        audit=audit,
    )


@router.get("/v1/extraction-runs/{run_id}", response_model=ExtractionRunView)
def get_extraction_run(
    request: Request,
    run_id: str = Path(min_length=36, max_length=36, pattern=_CANONICAL_UUID_PATTERN),
    principal: Principal = Depends(require_scope("ingestion:read")),
    engine: Engine = Depends(get_engine),
) -> ExtractionRunView:
    _require_query_shape(request, frozenset())
    run_id_text = str(_parse_canonical_uuid(run_id))
    with engine.connect() as c:
        organization_id = _organization_id(c, principal)
        set_tenant_context(c, organization_id)
        access = access_context_for_principal(
            principal, default_organization_id=organization_id
        )
        scope, scope_params = postgres_scope(access, alias="ingestion")
        run = (
            c.execute(
                text(
                    "SELECT run.id::text AS run_id, "
                    "run.ingestion_id::text AS ingestion_id, run.attempt_no, "
                    "run.outcome, run.extractor_version, run.prompt_version, "
                    "run.ocr_provider, run.llm_model, "
                    "run.ocr_raw_ref::text AS ocr_raw_ref, "
                    "run.rule_set_version, run.created_at::text AS created_at "
                    "FROM ingestion.extraction_run AS run "
                    "JOIN ingestion.ingestion AS ingestion "
                    "ON ingestion.id = run.ingestion_id "
                    "WHERE run.id = :id AND " + scope
                ),
                {
                    "id": run_id_text,
                    **scope_params,
                },
            )
            .mappings()
            .first()
        )
        if run is None:
            raise ApiError("NOT_FOUND", f"extraction run {run_id_text} not found")
        fields = (
            c.execute(
                text(
                    "SELECT field_name, value, evidence, provenance, "
                    "source_raw_artifact_id::text AS source_raw_artifact_id, validation_status, warnings, "
                    "llm_confidence, ocr_confidence, combined_confidence, confidence_band, source, "
                    "created_at::text AS created_at FROM ingestion.extracted_field "
                    "WHERE extraction_run_id = :id ORDER BY field_name"
                ),
                {"id": run_id_text},
            )
            .mappings()
            .all()
        )
        audit = audit_entries(c, run_id_text)

    return ExtractionRunView(
        **run, fields=[FieldView(**f) for f in fields], audit=audit
    )
