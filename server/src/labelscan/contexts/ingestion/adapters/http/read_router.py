"""Read-only endpoints for ingestion + extraction runs (query adapter).

No writes, no domain logic, read connections only. Reflects the append-only
nature: an ingestion exposes ALL its extraction runs (a re-extraction is a new
run, never an overwrite); the latest is marked `is_latest` (a derived read
projection, not a mutation). Fields carry their stored provenance verbatim.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.platform.http.deps import get_engine
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.read_models import AuditEntry, audit_entries
from labelscan.platform.http.security import require_scope

router = APIRouter()


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
    _principal=Depends(require_scope("ingestion:read")),
    engine: Engine = Depends(get_engine),
) -> IngestionView:
    with engine.connect() as c:
        row = (
            c.execute(
                text(
                    "SELECT id::text AS id, status, image_ref, checksum_sha256, barcode_raw, "
                    "client_captured_at::text AS cca, server_received_at::text AS sra, "
                    "correlation_id, trace_id FROM ingestion.ingestion WHERE id = :id"
                ),
                {"id": ingestion_id},
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
        audit=audit,
    )


@router.get("/v1/extraction-runs/{run_id}", response_model=ExtractionRunView)
def get_extraction_run(
    run_id: str,
    request: Request,
    _principal=Depends(require_scope("ingestion:read")),
    engine: Engine = Depends(get_engine),
) -> ExtractionRunView:
    with engine.connect() as c:
        run = (
            c.execute(
                text(
                    "SELECT id::text AS run_id, ingestion_id::text AS ingestion_id, attempt_no, outcome, "
                    "extractor_version, prompt_version, ocr_provider, llm_model, ocr_raw_ref::text AS ocr_raw_ref, "
                    "rule_set_version, created_at::text AS created_at "
                    "FROM ingestion.extraction_run WHERE id = :id"
                ),
                {"id": run_id},
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
