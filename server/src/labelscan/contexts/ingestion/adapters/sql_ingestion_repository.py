"""SQL implementation of IngestionWriteRepository (adapters layer).

One transaction does everything, in this order:
  - set the transaction-local audit context (else the audit trigger rejects the
    inserts — there is NO path to write without audit context);
  - claim idempotency atomically on the caller request-key scope (INSERT ... ON CONFLICT
    DO NOTHING), generating the ingestion id up front so the claim already carries
    the response — a duplicate returns the existing id and writes nothing;
  - insert ingestion then raw_artifact (FK order), both audited by the trigger.

HTTP idempotency is keyed on principal + portal/store + route + Idempotency-Key and
binds that key to the content SHA-256. Reusing it for different bytes is a conflict.
Framework-free callers without a key retain deterministic content-hash deduplication.
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
from labelscan.contexts.ingestion.application.submit_ingestion import (
    IngestionIdempotencyConflict,
)
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.tenant_context import set_tenant_context

_CLAIM = text(
    "INSERT INTO platform.idempotency_key "
    "(scope_hash, request_fingerprint, state, response_status, response_body_ref, expires_at) "
    "VALUES (:sh, :fp, 'completed', 202, :iid, now() + interval '24 hours') "
    "ON CONFLICT (scope_hash) DO NOTHING "
    "RETURNING response_body_ref"
)
_FIND_EXISTING = text(
    "SELECT response_body_ref, request_fingerprint "
    "FROM platform.idempotency_key WHERE scope_hash = :sh"
)
_INSERT_INGESTION = text(
    "INSERT INTO ingestion.ingestion "
    "(id, status, image_ref, checksum_sha256, barcode_raw, client_captured_at, "
    "organization_id, store_id, store_code, business_portal_id, "
    "trade_code_snapshot, trade_profile_version, captured_by_user_id, "
    "correlation_id, trace_id) "
    "VALUES (:iid, 'raw_stored', :ref, :ck, :bc, :cca, "
    ":organization_id, :store_id, :store, :business_portal_id, "
    ":trade_code_snapshot, :trade_profile_version, :captured_by_user_id, "
    ":corr, :trace)"
)
_INSERT_RAW = text(
    "INSERT INTO ingestion.raw_artifact "
    "(ingestion_id, organization_id, artifact_kind, storage_ref, checksum_sha256, correlation_id, trace_id) "
    "VALUES (:iid, :organization_id, 'image', :ref, :ck, :corr, :trace)"
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
    def _scope_hash(
        principal: str,
        route: str,
        request_identity: str,
        organization_id: str | None,
        store_code: str | None,
        business_portal_id: str | None,
    ) -> str:
        return hashlib.sha256(
            f"{organization_id or '-'}:{principal}:"
            f"{business_portal_id or store_code or '-'}:{route}:"
            f"{request_identity}".encode()
        ).hexdigest()

    def persist(
        self,
        *,
        content_sha256: str,
        storage_ref: str,
        barcode_raw: str | None,
        client_captured_at: str | None,
        store_code: str | None = None,
        organization_id: str | None = None,
        store_id: str | None = None,
        business_portal_id: str | None = None,
        trade_code_snapshot: str = "poissonnerie",
        trade_profile_version: str = "2",
        captured_by_user_id: str | None = None,
        principal: str,
        idempotency_key: str | None = None,
        route: str,
        audit: AuditContext,
        action: str,
    ) -> PersistResult:
        request_identity = idempotency_key or content_sha256
        scope_hash = self._scope_hash(
            principal,
            route,
            request_identity,
            organization_id,
            store_code,
            business_portal_id,
        )
        ingestion_id = str(uuid.uuid4())

        with self._engine.begin() as conn:
            if organization_id is None:
                organization_id = str(
                    conn.execute(
                        text(
                            "SELECT id FROM identity.organization "
                            "WHERE slug = 'labelscan'"
                        )
                    ).scalar_one()
                )
            set_tenant_context(conn, organization_id)
            # REQUIRED — without this the audit trigger aborts the inserts.
            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action=action,
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )

            # Production JWTs always name an identity.app_user.  Legacy local
            # test/header principals may predate that identity row; preserve
            # ingestion compatibility without weakening the tenant-qualified FK.
            if captured_by_user_id is not None:
                captured_by_user_id = conn.execute(
                    text(
                        "SELECT id::text FROM identity.app_user "
                        "WHERE organization_id = :organization_id AND id = :actor_id"
                    ),
                    {
                        "organization_id": organization_id,
                        "actor_id": captured_by_user_id,
                    },
                ).scalar_one_or_none()

            claimed = conn.execute(
                _CLAIM,
                {"sh": scope_hash, "fp": content_sha256, "iid": ingestion_id},
            ).scalar_one_or_none()

            if claimed is None:
                # Same request key + same fingerprint is a replay.  Reusing a key for
                # different bytes is an integrity conflict, never an alias to old data.
                existing = (
                    conn.execute(_FIND_EXISTING, {"sh": scope_hash}).mappings().one()
                )
                if existing["request_fingerprint"] != content_sha256:
                    raise IngestionIdempotencyConflict()
                return PersistResult(
                    ingestion_id=str(existing["response_body_ref"]), created=False
                )

            params = {
                "iid": ingestion_id,
                "ref": storage_ref,
                "ck": content_sha256,
                "corr": audit.correlation_id,
                "trace": audit.trace_id,
                "organization_id": organization_id,
            }
            conn.execute(
                _INSERT_INGESTION,
                {
                    **params,
                    "bc": barcode_raw,
                    "cca": client_captured_at,
                    "store": store_code,
                    "store_id": store_id,
                    "business_portal_id": business_portal_id,
                    "trade_code_snapshot": trade_code_snapshot,
                    "trade_profile_version": trade_profile_version,
                    "captured_by_user_id": captured_by_user_id,
                },
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
                            "organization_id": organization_id,
                            "store_id": store_id,
                            "business_portal_id": business_portal_id,
                            "trade_code_snapshot": trade_code_snapshot,
                            "trade_profile_version": trade_profile_version,
                            "captured_by_user_id": captured_by_user_id,
                        }
                    ),
                    "corr": audit.correlation_id,
                    "trace": audit.trace_id,
                },
            )
            return PersistResult(ingestion_id=ingestion_id, created=True)
