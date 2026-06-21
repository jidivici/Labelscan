"""SQL implementation of IngestionWriteRepository (adapters layer).

One transaction does everything, in this order:
  - set the transaction-local audit context (else the audit trigger rejects the
    inserts — there is NO path to write without audit context);
  - claim idempotency atomically on the content scope hash (INSERT ... ON CONFLICT
    DO NOTHING), generating the ingestion id up front so the claim already carries
    the response — a duplicate returns the existing id and writes nothing;
  - insert ingestion then raw_artifact (FK order), both audited by the trigger.

Idempotency is keyed on the CONTENT hash (scope = principal + route + sha256), so
re-submitting identical bytes never creates a second record.
"""

from __future__ import annotations

import hashlib
import json
import uuid

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.ingestion.application.ports import (
    AuditContext,
    IngestionWriteRepository,
    PersistResult,
)
from labelscan.platform.db.audit_context import set_audit_context

_CLAIM = text(
    "INSERT INTO platform.idempotency_key "
    "(scope_hash, request_fingerprint, state, response_status, response_body_ref, expires_at) "
    "VALUES (:sh, :fp, 'completed', 202, :iid, now() + interval '24 hours') "
    "ON CONFLICT (scope_hash) DO NOTHING "
    "RETURNING response_body_ref"
)
_FIND_EXISTING = text(
    "SELECT response_body_ref FROM platform.idempotency_key WHERE scope_hash = :sh"
)
_INSERT_INGESTION = text(
    "INSERT INTO ingestion.ingestion "
    "(id, status, image_ref, checksum_sha256, barcode_raw, client_captured_at, correlation_id, trace_id) "
    "VALUES (:iid, 'raw_stored', :ref, :ck, :bc, :cca, :corr, :trace)"
)
_INSERT_RAW = text(
    "INSERT INTO ingestion.raw_artifact "
    "(ingestion_id, artifact_kind, storage_ref, checksum_sha256, correlation_id, trace_id) "
    "VALUES (:iid, 'image', :ref, :ck, :corr, :trace)"
)
# Transactional outbox: enqueued in the SAME transaction as the ingestion write,
# so the event exists if and only if the ingestion committed. NOT a call into
# extraction — just a durable row the relay worker will pick up later (PG-3).
_ENQUEUE_OUTBOX = text(
    "INSERT INTO platform.outbox (event_type, payload, correlation_id, trace_id) "
    "VALUES ('ingestion.raw_stored', CAST(:payload AS jsonb), :corr, :trace)"
)


class SqlIngestionRepository(IngestionWriteRepository):
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    @staticmethod
    def _scope_hash(principal: str, route: str, content_sha256: str) -> str:
        return hashlib.sha256(
            f"{principal}:{route}:{content_sha256}".encode()
        ).hexdigest()

    def persist(
        self,
        *,
        content_sha256: str,
        storage_ref: str,
        barcode_raw: str | None,
        client_captured_at: str | None,
        principal: str,
        route: str,
        audit: AuditContext,
        action: str,
    ) -> PersistResult:
        scope_hash = self._scope_hash(principal, route, content_sha256)
        ingestion_id = str(uuid.uuid4())

        with self._engine.begin() as conn:
            # REQUIRED — without this the audit trigger aborts the inserts.
            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action=action,
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )

            claimed = conn.execute(
                _CLAIM,
                {"sh": scope_hash, "fp": content_sha256, "iid": ingestion_id},
            ).scalar_one_or_none()

            if claimed is None:
                # Duplicate content within the dedup window -> return the existing id, write nothing.
                existing = conn.execute(_FIND_EXISTING, {"sh": scope_hash}).scalar_one()
                return PersistResult(ingestion_id=str(existing), created=False)

            params = {
                "iid": ingestion_id,
                "ref": storage_ref,
                "ck": content_sha256,
                "corr": audit.correlation_id,
                "trace": audit.trace_id,
            }
            conn.execute(
                _INSERT_INGESTION,
                {**params, "bc": barcode_raw, "cca": client_captured_at},
            )
            conn.execute(_INSERT_RAW, params)
            conn.execute(
                _ENQUEUE_OUTBOX,
                {
                    "payload": json.dumps(
                        {
                            "ingestion_id": ingestion_id,
                            "checksum_sha256": content_sha256,
                            "image_ref": storage_ref,
                        }
                    ),
                    "corr": audit.correlation_id,
                    "trace": audit.trace_id,
                },
            )
            return PersistResult(ingestion_id=ingestion_id, created=True)
