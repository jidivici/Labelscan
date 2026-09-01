"""SubmitIngestion use case — the internal ingestion entrypoint.

Durability contract:
  1. compute the content hash,
  2. persist the raw bytes DURABLY (object store, fsync) — before any DB row,
  3. record the ingestion + raw_artifact in one audited transaction,
  4. only then return the 202 acceptance.

A crash at any point loses nothing: the bytes are content-addressed and durable
before the DB write, the DB write is atomic, and the 202 is returned only after
commit. HTTP retries are idempotent on their request key and that key is bound to
the content hash; internal callers without a key retain content-hash deduplication.

No business logic, no extraction here (PG-2 scope).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from labelscan.contexts.ingestion.application.ports import (
    AuditContext,
    IngestionWriteRepository,
    RawStore,
)
from labelscan.contexts.ingestion.domain.input_validation import (
    validate_barcode_raw,
    validate_client_captured_at,
    validate_idempotency_key,
)
from labelscan.contexts.ingestion.domain.status import IngestionStatus

_ACTION = "ingestion.submitted"
_ROUTE = "POST /v1/ingestions"


@dataclass(frozen=True)
class SubmitIngestionCommand:
    image_bytes: bytes
    content_type: str
    actor_id: str  # the authenticated principal, passed by the trusted caller
    correlation_id: str
    trace_id: str
    principal: str  # idempotency scope (e.g. device id); usually == actor_id
    idempotency_key: str | None = None
    barcode_raw: str | None = None
    client_captured_at: str | None = None
    store_code: str | None = None
    organization_id: str | None = None
    store_id: str | None = None
    business_portal_id: str | None = None
    trade_code_snapshot: str = "poissonnerie"
    trade_profile_version: str = "2"
    sanitized_image_bytes: bytes | None = None
    sanitized_content_type: str = "image/jpeg"


@dataclass(frozen=True)
class IngestionAccepted:
    ingestion_id: str
    status: str
    http_status: int  # 202 — returned ONLY after the durable write has committed
    replayed: bool  # True => idempotent replay of an existing ingestion


_ACCEPTED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic"}
_MAX_IMAGE_BYTES = 10 * 1024 * 1024


class IngestionIdempotencyConflict(Exception):
    """A request key was reused with different image content."""


class SubmitIngestion:
    def __init__(
        self, raw_store: RawStore, repository: IngestionWriteRepository
    ) -> None:
        self._raw_store = raw_store
        self._repository = repository

    def __call__(self, cmd: SubmitIngestionCommand) -> IngestionAccepted:
        # Boundary guards (not business logic): reject obviously invalid input early.
        if not cmd.image_bytes:
            raise ValueError("empty payload: no image bytes")
        if len(cmd.image_bytes) > _MAX_IMAGE_BYTES:
            raise ValueError("image exceeds the configured size limit")
        if cmd.content_type not in _ACCEPTED_TYPES:
            raise ValueError(f"unsupported media type: {cmd.content_type}")
        barcode_raw = validate_barcode_raw(cmd.barcode_raw)
        client_captured_at = validate_client_captured_at(cmd.client_captured_at)
        idempotency_key = validate_idempotency_key(cmd.idempotency_key, required=False)

        original_checksum = hashlib.sha256(cmd.image_bytes).hexdigest()

        # (2) DURABLE raw store FIRST — the exact source stays available for a
        # restricted audit while OCR/display use only the decoded, metadata-free copy.
        original_storage_ref = self._raw_store.put(
            cmd.image_bytes,
            checksum=original_checksum,
            organization_id=cmd.organization_id,
        )
        safe_bytes = cmd.sanitized_image_bytes or cmd.image_bytes
        safe_checksum = hashlib.sha256(safe_bytes).hexdigest()
        safe_storage_ref = self._raw_store.put(
            safe_bytes,
            checksum=safe_checksum,
            organization_id=cmd.organization_id,
        )

        # (3) atomic, audited, idempotent DB write.
        result = self._repository.persist(
            content_sha256=safe_checksum,
            storage_ref=safe_storage_ref,
            original_content_sha256=(
                original_checksum if cmd.sanitized_image_bytes is not None else None
            ),
            original_storage_ref=(
                original_storage_ref if cmd.sanitized_image_bytes is not None else None
            ),
            barcode_raw=barcode_raw,
            client_captured_at=client_captured_at,
            store_code=cmd.store_code,
            organization_id=cmd.organization_id,
            store_id=cmd.store_id,
            business_portal_id=cmd.business_portal_id,
            trade_code_snapshot=cmd.trade_code_snapshot,
            trade_profile_version=cmd.trade_profile_version,
            captured_by_user_id=cmd.actor_id,
            principal=cmd.principal,
            idempotency_key=idempotency_key,
            route=_ROUTE,
            audit=AuditContext(
                actor_id=cmd.actor_id,
                correlation_id=cmd.correlation_id,
                trace_id=cmd.trace_id,
            ),
            action=_ACTION,
        )

        # (4) 202 only now — the write is committed and durable.
        return IngestionAccepted(
            ingestion_id=result.ingestion_id,
            status=IngestionStatus.RAW_STORED.value,
            http_status=202,
            replayed=not result.created,
        )
