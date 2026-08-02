"""PostgreSQL adapter for the atomic complete review operation."""

from __future__ import annotations

import hashlib
import json

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.ingestion.application.finalize_review import (
    ReviewIdempotencyConflict,
    ReviewNotAllowed,
)
from labelscan.contexts.ingestion.application.ports import (
    AuditContext,
    FinalizedReview,
    ReviewRepository,
)
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.tenant_context import set_tenant_context

_REVIEWABLE = ("extracted", "needs_review", "ocr_skipped_garbage")


class SqlReviewRepository(ReviewRepository):
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def finalize(
        self,
        *,
        ingestion_id: str,
        organization_id: str,
        fields: dict[str, str | None],
        note: str | None,
        idempotency_key: str,
        audit: AuditContext,
        action: str,
    ) -> FinalizedReview | None:
        request_hash = hashlib.sha256(
            json.dumps(
                {
                    "ingestion_id": ingestion_id,
                    "fields": fields,
                    "note": note,
                },
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        with self._engine.begin() as conn:
            set_tenant_context(conn, organization_id)
            # Serialize identical keys before inspecting the append-only ledger.
            # This closes the race where two mobile retries arrive concurrently.
            conn.execute(
                text(
                    "SELECT pg_advisory_xact_lock("
                    "hashtextextended(:lock_key, 0))"
                ),
                {"lock_key": f"finalize_review:{audit.actor_id}:{idempotency_key}"},
            )
            seen = (
                conn.execute(
                    text(
                        "SELECT run_id::text AS run_id, "
                        "ingestion_id::text AS ingestion_id, request_hash "
                        "FROM ingestion.request_idempotency "
                        "WHERE endpoint = 'finalize_review' "
                        "AND actor_id = :actor AND idempotency_key = :key"
                    ),
                    {"actor": audit.actor_id, "key": idempotency_key},
                )
                .mappings()
                .first()
            )
            if seen:
                if (
                    seen["ingestion_id"] != ingestion_id
                    or seen["request_hash"] != request_hash
                ):
                    raise ReviewIdempotencyConflict()
                return FinalizedReview(
                    ingestion_id=ingestion_id,
                    run_id=seen["run_id"],
                    status="confirmed",
                    replayed=True,
                )

            ingestion = (
                conn.execute(
                    text(
                        "SELECT status FROM ingestion.ingestion "
                        "WHERE id = :id AND organization_id = :organization_id "
                        "FOR UPDATE"
                    ),
                    {"id": ingestion_id, "organization_id": organization_id},
                )
                .mappings()
                .first()
            )
            if ingestion is None:
                return None
            if ingestion["status"] not in _REVIEWABLE:
                raise ReviewNotAllowed(ingestion["status"])

            latest = (
                conn.execute(
                    text(
                        "SELECT id::text AS id, attempt_no "
                        "FROM ingestion.extraction_run "
                        "WHERE ingestion_id = :id ORDER BY attempt_no DESC LIMIT 1"
                    ),
                    {"id": ingestion_id},
                )
                .mappings()
                .first()
            )
            if latest is None:
                raise ReviewNotAllowed(ingestion["status"])

            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action=action,
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )
            run_id = str(
                conn.execute(
                    text(
                        """
                        INSERT INTO ingestion.extraction_run (
                            ingestion_id, attempt_no, outcome, extractor_version,
                            prompt_version, ocr_provider, llm_model, escalation_model,
                            ocr_raw_ref, rule_set_version, correlation_id, trace_id
                        )
                        SELECT
                            ingestion_id, :attempt, 'extracted', extractor_version,
                            prompt_version, ocr_provider, llm_model, escalation_model,
                            ocr_raw_ref, rule_set_version, :correlation_id, :trace_id
                        FROM ingestion.extraction_run
                        WHERE id = :parent_id
                        RETURNING id
                        """
                    ),
                    {
                        "attempt": int(latest["attempt_no"]) + 1,
                        "correlation_id": audit.correlation_id,
                        "trace_id": audit.trace_id,
                        "parent_id": latest["id"],
                    },
                ).scalar_one()
            )
            image_artifact_id = conn.execute(
                text(
                    "SELECT id::text FROM ingestion.raw_artifact "
                    "WHERE ingestion_id = :id AND organization_id = :organization_id "
                    "AND artifact_kind = 'image' ORDER BY occurred_at LIMIT 1"
                ),
                {"id": ingestion_id, "organization_id": organization_id},
            ).scalar_one_or_none()

            field_rows = []
            for field_name, value in fields.items():
                present = value is not None
                field_rows.append(
                    {
                        "run_id": run_id,
                        "field_name": field_name,
                        "value": json.dumps(value) if present else None,
                        "evidence": (
                            json.dumps([note or "Validé par l’opérateur"])
                            if present
                            else None
                        ),
                        "provenance": (
                            json.dumps(
                                {
                                    "source": "human",
                                    "actor_id": audit.actor_id,
                                    "note": note,
                                }
                            )
                            if present
                            else None
                        ),
                        "source_id": image_artifact_id if present else None,
                        "validation": "present" if present else "missing",
                        "confidence": 1.0 if present else 0.0,
                        "band": "high" if present else "low",
                    }
                )
            conn.execute(
                text(
                    """
                    INSERT INTO ingestion.extracted_field (
                        extraction_run_id, field_name, value, evidence, provenance,
                        source_raw_artifact_id, validation_status, warnings,
                        combined_confidence, confidence_band, source
                    ) VALUES (
                        :run_id, :field_name, CAST(:value AS jsonb),
                        CAST(:evidence AS jsonb), CAST(:provenance AS jsonb),
                        :source_id, :validation, '[]'::jsonb,
                        :confidence, :band, 'human'
                    )
                    """
                ),
                field_rows,
            )
            conn.execute(
                text(
                    "UPDATE ingestion.ingestion SET status = 'confirmed' "
                    "WHERE id = :id AND organization_id = :organization_id"
                ),
                {"id": ingestion_id, "organization_id": organization_id},
            )
            conn.execute(
                text(
                    """
                    INSERT INTO ingestion.request_idempotency (
                        endpoint, actor_id, idempotency_key, ingestion_id, run_id,
                        field_name, request_hash
                    ) VALUES (
                        'finalize_review', :actor, :key, :ingestion_id, :run_id,
                        NULL, :request_hash
                    )
                    """
                ),
                {
                    "actor": audit.actor_id,
                    "key": idempotency_key,
                    "ingestion_id": ingestion_id,
                    "run_id": run_id,
                    "request_hash": request_hash,
                },
            )
            conn.execute(
                text(
                    """
                    INSERT INTO platform.outbox (
                        event_type, payload, correlation_id, trace_id
                    ) VALUES (
                        'review.finalized', CAST(:payload AS jsonb),
                        :correlation_id, :trace_id
                    )
                    """
                ),
                {
                    "payload": json.dumps(
                        {
                            "organization_id": organization_id,
                            "ingestion_id": ingestion_id,
                            "run_id": run_id,
                        }
                    ),
                    "correlation_id": audit.correlation_id,
                    "trace_id": audit.trace_id,
                },
            )
            return FinalizedReview(
                ingestion_id=ingestion_id,
                run_id=run_id,
                status="confirmed",
                replayed=False,
            )
