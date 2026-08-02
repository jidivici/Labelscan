"""SQL implementation of ConfirmIngestionRepository (adapters layer).

One audited transaction: lock the ingestion row (FOR UPDATE — two concurrent
confirms serialize instead of double-auditing), check the state, transition to
'confirmed'. The status UPDATE fires the existing trg_ingestion_audit_update
trigger, so the confirmation is recorded in the unbypassable audit trail with the
operator as actor.

State rules (review-ready gate):
  - extracted / needs_review / ocr_skipped_garbage  -> confirmed (the write)
  - confirmed                                       -> replayed (idempotent, no write)
  - anything else (processing, failed, rejected…)   -> ConfirmNotAllowed (409)
  - missing row                                     -> None (404)
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.ingestion.application.ports import (
    AuditContext,
    ConfirmedIngestion,
    ConfirmIngestionRepository,
    ConfirmNotAllowed,
)
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.tenant_context import set_tenant_context

_CONFIRMABLE = ("extracted", "needs_review", "ocr_skipped_garbage")


class SqlConfirmRepository(ConfirmIngestionRepository):
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def confirm(
        self, *, ingestion_id: str, audit: AuditContext, action: str
    ) -> ConfirmedIngestion | None:
        with self._engine.begin() as conn:
            if audit.organization_id:
                set_tenant_context(conn, audit.organization_id)
            status = conn.execute(
                text(
                    "SELECT status FROM ingestion.ingestion WHERE id = :id "
                    "AND (CAST(:organization_id AS text) IS NULL "
                    "OR organization_id::text = :organization_id) "
                    "FOR UPDATE"
                ),
                {"id": ingestion_id, "organization_id": audit.organization_id},
            ).scalar_one_or_none()
            if status is None:
                return None
            if status == "confirmed":
                return ConfirmedIngestion(
                    ingestion_id=ingestion_id, status="confirmed", replayed=True
                )
            if status not in _CONFIRMABLE:
                raise ConfirmNotAllowed(status)

            # REQUIRED — the ingestion AFTER UPDATE audit trigger aborts otherwise.
            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action=action,
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )
            conn.execute(
                text(
                    "UPDATE ingestion.ingestion SET status = 'confirmed' WHERE id = :id "
                    "AND (CAST(:organization_id AS text) IS NULL "
                    "OR organization_id::text = :organization_id)"
                ),
                {"id": ingestion_id, "organization_id": audit.organization_id},
            )
            return ConfirmedIngestion(
                ingestion_id=ingestion_id, status="confirmed", replayed=False
            )
