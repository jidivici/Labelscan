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

import time
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.platform.http.deps import get_engine
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.read_models import AuditEntry, audit_entries
from labelscan.platform.http.security import Principal, require_scope
from labelscan.platform.db.tenant_context import set_tenant_context

router = APIRouter()

# Long-poll bounds: the hold is ALWAYS bounded (a client cannot pin a thread
# indefinitely) and the probe cadence keeps DB load negligible (one indexed
# SELECT status every ~300 ms per waiting client).
_MAX_WAIT_S = 25.0
_PROBE_INTERVAL_S = 0.3


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
        return c.execute(
            text(
                "SELECT status FROM ingestion.ingestion "
                "WHERE id = :id AND organization_id = :organization_id "
                "AND (:all_stores OR store_id::text = :store_id)"
            ),
            {
                "id": ingestion_id,
                "organization_id": organization_id,
                "all_stores": principal.role == "admin",
                "store_id": principal.store_id or "",
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
    value: Any | None
    evidence: Any | None
    provenance: (
        Any | None
    )  # {raw_artifact_id, spans:[{page, offset_start, offset_end}]}
    source_raw_artifact_id: str | None
    validation_status: str
    warnings: Any
    llm_confidence: float | None
    ocr_confidence: float | None
    combined_confidence: float
    confidence_band: str
    source: str
    created_at: str


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


@router.get("/v1/ingestions/{ingestion_id}", response_model=IngestionView)
def get_ingestion(
    ingestion_id: str,
    request: Request,
    wait: float = Query(
        default=0.0,
        description=(
            "Long-poll hold in seconds (Tier 4), clamped to 25. Requires "
            "last_status; the response returns as soon as the status differs "
            "from last_status, or when the hold expires (with the current state)."
        ),
    ),
    last_status: str | None = Query(
        default=None,
        description="The status the client last observed (long-poll baseline).",
    ),
    principal: Principal = Depends(require_scope("ingestion:read")),
    engine: Engine = Depends(get_engine),
) -> IngestionView:
    # ── Tier 4 long-poll: bounded server-side wait for a status CHANGE ─────────
    # Both params required to arm the hold (a bare `wait` has no baseline to
    # compare against). A missing ingestion breaks out immediately — the view
    # load below raises the same 404 the plain GET always did.
    wait_s = clamp_wait(wait)
    if wait_s > 0 and last_status:
        deadline = time.monotonic() + wait_s
        while True:
            current = _probe_status(engine, ingestion_id, principal)
            if current is None or current != last_status:
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break  # hold expired — return the (unchanged) current state
            time.sleep(min(_PROBE_INTERVAL_S, remaining))

    with engine.connect() as c:
        organization_id = _organization_id(c, principal)
        set_tenant_context(c, organization_id)
        row = (
            c.execute(
                text(
                    "SELECT id::text AS id, status, image_ref, checksum_sha256, barcode_raw, "
                    "client_captured_at::text AS cca, server_received_at::text AS sra, "
                    "correlation_id, trace_id FROM ingestion.ingestion "
                    "WHERE id = :id AND organization_id = :organization_id "
                    "AND (:all_stores OR store_id::text = :store_id)"
                ),
                {
                    "id": ingestion_id,
                    "organization_id": organization_id,
                    "all_stores": principal.role == "admin",
                    "store_id": principal.store_id or "",
                },
            )
            .mappings()
            .first()
        )
        if row is None:
            raise ApiError("NOT_FOUND", f"ingestion {ingestion_id} not found")
        arts = (
            c.execute(
                text(
                    "SELECT id::text AS id, artifact_kind, storage_ref, checksum_sha256, "
                    "occurred_at::text AS occurred_at FROM ingestion.raw_artifact "
                    "WHERE ingestion_id = :id ORDER BY occurred_at"
                ),
                {"id": ingestion_id},
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
                {"id": ingestion_id},
            )
            .mappings()
            .all()
        )
        audit = audit_entries(c, ingestion_id)

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
                    {"id": ingestion_id},
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
        audit=audit,
    )


@router.get("/v1/extraction-runs/{run_id}", response_model=ExtractionRunView)
def get_extraction_run(
    run_id: str,
    request: Request,
    principal: Principal = Depends(require_scope("ingestion:read")),
    engine: Engine = Depends(get_engine),
) -> ExtractionRunView:
    with engine.connect() as c:
        organization_id = _organization_id(c, principal)
        set_tenant_context(c, organization_id)
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
                    "WHERE run.id = :id "
                    "AND ingestion.organization_id = :organization_id "
                    "AND (:all_stores OR ingestion.store_id::text = :store_id)"
                ),
                {
                    "id": run_id,
                    "organization_id": organization_id,
                    "all_stores": principal.role == "admin",
                    "store_id": principal.store_id or "",
                },
            )
            .mappings()
            .first()
        )
        if run is None:
            raise ApiError("NOT_FOUND", f"extraction run {run_id} not found")
        fields = (
            c.execute(
                text(
                    "SELECT field_name, value, evidence, provenance, "
                    "source_raw_artifact_id::text AS source_raw_artifact_id, validation_status, warnings, "
                    "llm_confidence, ocr_confidence, combined_confidence, confidence_band, source, "
                    "created_at::text AS created_at FROM ingestion.extracted_field "
                    "WHERE extraction_run_id = :id ORDER BY field_name"
                ),
                {"id": run_id},
            )
            .mappings()
            .all()
        )
        audit = audit_entries(c, run_id)

    return ExtractionRunView(
        **run, fields=[FieldView(**f) for f in fields], audit=audit
    )
