"""SQL implementation of FieldOverrideRepository (adapters layer).

A human override is recorded as a NEW append-only extraction_run that is a full COPY
of the latest run with exactly one field replaced (source='human'). The original run is
never mutated (ADR-0003/0005 immutability triggers). Because the new run carries the
COMPLETE field set, the existing read model (`GET /v1/extraction-runs/{id}`, latest run
= max attempt_no) keeps working unchanged — it now returns the human-validated value.

Everything runs in ONE audited transaction:
  - set the transaction-local audit context (else the extraction_run AFTER INSERT audit
    trigger aborts the write — there is no path to write without audit context);
  - copy the latest run's row (new attempt_no, this request's correlation/trace);
  - copy every field EXCEPT the overridden one verbatim (keeps machine provenance);
  - insert the overridden field with human provenance (value) or as cleared (null),
    honoring ck_value_requires_provenance / ck_evidence_iff_value.

Idempotent: if the latest run already carries this exact human value, no new run is
written and the existing field is returned (replayed=True) — so a client retry of the
same override never piles up duplicate runs.
"""

from __future__ import annotations

import json

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.ingestion.application.ports import (
    AuditContext,
    FieldOverrideRepository,
    OverriddenField,
)
from labelscan.platform.db.audit_context import set_audit_context

_LATEST_RUN = text(
    "SELECT id::text AS id, attempt_no FROM ingestion.extraction_run "
    "WHERE ingestion_id = :iid ORDER BY attempt_no DESC LIMIT 1"
)
_CURRENT_FIELD = text(
    "SELECT value, source, validation_status, combined_confidence, confidence_band "
    "FROM ingestion.extracted_field WHERE extraction_run_id = :rid AND field_name = :fn"
)
_IMAGE_ARTIFACT = text(
    "SELECT id::text FROM ingestion.raw_artifact "
    "WHERE ingestion_id = :iid AND artifact_kind = 'image' ORDER BY occurred_at LIMIT 1"
)
# New run = a COPY of the parent row (outcome/versions/providers/escalation/ocr_ref
# preserved — the override records a value, not a new machine verdict), with a fresh
# attempt_no and this request's correlation/trace.
_INSERT_RUN_COPY = text(
    "INSERT INTO ingestion.extraction_run "
    "(ingestion_id, attempt_no, outcome, extractor_version, prompt_version, ocr_provider, "
    " llm_model, escalation_model, ocr_raw_ref, rule_set_version, correlation_id, trace_id) "
    "SELECT ingestion_id, :att, outcome, extractor_version, prompt_version, ocr_provider, "
    " llm_model, escalation_model, ocr_raw_ref, rule_set_version, :corr, :trace "
    "FROM ingestion.extraction_run WHERE id = :rid RETURNING id::text"
)
_COPY_FIELDS_EXCEPT = text(
    "INSERT INTO ingestion.extracted_field "
    "(extraction_run_id, field_name, value, evidence, provenance, source_raw_artifact_id, "
    " validation_status, warnings, llm_confidence, ocr_confidence, combined_confidence, "
    " confidence_band, source) "
    "SELECT :new_rid, field_name, value, evidence, provenance, source_raw_artifact_id, "
    " validation_status, warnings, llm_confidence, ocr_confidence, combined_confidence, "
    " confidence_band, source "
    "FROM ingestion.extracted_field WHERE extraction_run_id = :rid AND field_name <> :fn"
)
# A non-null human value cites the IMAGE artifact as its source (the operator validated
# against the photo) + human provenance — satisfies ck_value_requires_provenance.
_INSERT_HUMAN_VALUE = text(
    "INSERT INTO ingestion.extracted_field "
    "(extraction_run_id, field_name, value, evidence, provenance, source_raw_artifact_id, "
    " validation_status, warnings, combined_confidence, confidence_band, source) "
    "VALUES (:rid, :fn, CAST(:val AS jsonb), CAST(:ev AS jsonb), CAST(:prov AS jsonb), :src, "
    " 'present', '[]'::jsonb, 1.0, 'high', 'human')"
)
# A cleared field carries no value/evidence/provenance (storage invariants hold).
_INSERT_HUMAN_CLEARED = text(
    "INSERT INTO ingestion.extracted_field "
    "(extraction_run_id, field_name, value, evidence, provenance, source_raw_artifact_id, "
    " validation_status, warnings, combined_confidence, confidence_band, source) "
    "VALUES (:rid, :fn, NULL, NULL, NULL, NULL, 'missing', '[]'::jsonb, 0.0, 'low', 'human')"
)


class SqlFieldOverrideRepository(FieldOverrideRepository):
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def override_field(
        self,
        *,
        ingestion_id: str,
        field_name: str,
        value: str | None,
        note: str | None,
        audit: AuditContext,
        action: str,
    ) -> OverriddenField | None:
        with self._engine.begin() as conn:
            # REQUIRED — the extraction_run AFTER INSERT audit trigger aborts otherwise.
            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action=action,
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )

            latest = conn.execute(_LATEST_RUN, {"iid": ingestion_id}).mappings().first()
            if latest is None:
                return None  # no run for this ingestion -> 404
            parent_run_id = latest["id"]

            current = (
                conn.execute(
                    _CURRENT_FIELD, {"rid": parent_run_id, "fn": field_name}
                )
                .mappings()
                .first()
            )
            # Idempotent replay: latest run already carries this exact human value.
            if (
                current is not None
                and current["source"] == "human"
                and current["value"] == value
            ):
                return OverriddenField(
                    run_id=parent_run_id,
                    field_name=field_name,
                    value=value,
                    validation_status=current["validation_status"],
                    source="human",
                    combined_confidence=float(current["combined_confidence"]),
                    confidence_band=current["confidence_band"],
                    replayed=True,
                )

            new_run_id = conn.execute(
                _INSERT_RUN_COPY,
                {
                    "att": latest["attempt_no"] + 1,
                    "corr": audit.correlation_id,
                    "trace": audit.trace_id,
                    "rid": parent_run_id,
                },
            ).scalar_one()
            conn.execute(
                _COPY_FIELDS_EXCEPT,
                {"new_rid": new_run_id, "rid": parent_run_id, "fn": field_name},
            )

            if value is not None:
                image_id = conn.execute(
                    _IMAGE_ARTIFACT, {"iid": ingestion_id}
                ).scalar_one_or_none()
                conn.execute(
                    _INSERT_HUMAN_VALUE,
                    {
                        "rid": new_run_id,
                        "fn": field_name,
                        "val": json.dumps(value),
                        "ev": json.dumps([note] if note else ["Validé par l'opérateur"]),
                        "prov": json.dumps(
                            {"source": "human", "actor_id": audit.actor_id, "note": note}
                        ),
                        "src": image_id,
                    },
                )
                return OverriddenField(
                    run_id=str(new_run_id),
                    field_name=field_name,
                    value=value,
                    validation_status="present",
                    source="human",
                    combined_confidence=1.0,
                    confidence_band="high",
                    replayed=False,
                )

            conn.execute(_INSERT_HUMAN_CLEARED, {"rid": new_run_id, "fn": field_name})
            return OverriddenField(
                run_id=str(new_run_id),
                field_name=field_name,
                value=None,
                validation_status="missing",
                source="human",
                combined_confidence=0.0,
                confidence_band="low",
                replayed=False,
            )
