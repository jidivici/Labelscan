"""PostgreSQL adapter for retrying a failed extraction with its existing photo."""

from __future__ import annotations

import json

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.ingestion.application.ports import (
    AuditContext,
    RetriedExtraction,
)
from labelscan.contexts.ingestion.application.retry_extraction import (
    ExtractionRetryNotAllowed,
)
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.tenant_context import set_tenant_context
from labelscan.platform.http.access import AccessContext, postgres_scope

_ALREADY_RETRYING = frozenset(
    {"raw_stored", "ocr_running", "ocr_done", "extraction_running"}
)


class SqlExtractionRetryRepository:
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def retry(
        self,
        *,
        ingestion_id: str,
        organization_id: str,
        audit: AuditContext,
        action: str,
        access: AccessContext | None = None,
    ) -> RetriedExtraction | None:
        with self._engine.begin() as conn:
            set_tenant_context(conn, organization_id)
            access_predicate = ""
            access_params: dict[str, object] = {}
            if access is not None and access.organization_id:
                predicate, access_params = postgres_scope(access, alias="ingestion")
                access_predicate = f" AND {predicate}"
            ingestion = (
                conn.execute(
                    text(
                        "SELECT status, store_id::text AS store_id, "
                        "business_portal_id::text AS business_portal_id, "
                        "trade_code_snapshot, trade_profile_version, "
                        "captured_by_user_id::text AS captured_by_user_id "
                        "FROM ingestion.ingestion AS ingestion "
                        "WHERE id = :id AND organization_id = :organization_id "
                        f"{access_predicate} FOR UPDATE"
                    ),
                    {
                        "id": ingestion_id,
                        "organization_id": organization_id,
                        **access_params,
                    },
                )
                .mappings()
                .first()
            )
            if ingestion is None:
                return None
            current_status = str(ingestion["status"])
            if current_status in _ALREADY_RETRYING:
                return RetriedExtraction(ingestion_id, current_status, True)
            if current_status != "extraction_failed":
                raise ExtractionRetryNotAllowed(current_status)

            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action=action,
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )
            conn.execute(
                text(
                    "UPDATE ingestion.ingestion SET status = 'raw_stored' "
                    "WHERE id = :id AND organization_id = :organization_id"
                ),
                {"id": ingestion_id, "organization_id": organization_id},
            )
            conn.execute(
                text(
                    "INSERT INTO platform.outbox "
                    "(event_type, payload, correlation_id, trace_id) "
                    "VALUES ('ingestion.raw_stored', CAST(:payload AS jsonb), :corr, :trace)"
                ),
                {
                    "payload": json.dumps(
                        {
                            "ingestion_id": ingestion_id,
                            "organization_id": organization_id,
                            "store_id": ingestion["store_id"],
                            "business_portal_id": ingestion["business_portal_id"],
                            "trade_code_snapshot": ingestion["trade_code_snapshot"],
                            "trade_profile_version": ingestion["trade_profile_version"],
                            "captured_by_user_id": ingestion["captured_by_user_id"],
                        }
                    ),
                    "corr": audit.correlation_id,
                    "trace": audit.trace_id,
                },
            )
            return RetriedExtraction(ingestion_id, "raw_stored", False)
