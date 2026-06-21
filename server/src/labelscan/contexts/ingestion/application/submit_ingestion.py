"""SubmitIngestion use case — the internal ingestion entrypoint.

Durability contract:
  1. compute the content hash,
  2. persist the raw bytes DURABLY (object store, fsync) — before any DB row,
  3. record the ingestion + raw_artifact in one audited transaction,
  4. only then return the 202 acceptance.

A crash at any point loses nothing: the bytes are content-addressed and durable
before the DB write, the DB write is atomic, and the 202 is returned only after
commit. Re-submitting identical content is idempotent (no duplicate record).

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
    barcode_raw: str | None = None
    client_captured_at: str | None = None


@dataclass(frozen=True)
class IngestionAccepted:
    ingestion_id: str
    status: str
    http_status: int  # 202 — returned ONLY after the durable write has committed
    replayed: bool  # True => idempotent replay of an existing ingestion


_ACCEPTED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic"}


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
        if cmd.content_type not in _ACCEPTED_TYPES:
            raise ValueError(f"unsupported media type: {cmd.content_type}")

        checksum = hashlib.sha256(cmd.image_bytes).hexdigest()

        # (2) DURABLE raw store FIRST — bytes are safe before any DB row exists.
        storage_ref = self._raw_store.put(cmd.image_bytes, checksum=checksum)

        # (3) atomic, audited, idempotent DB write.
        result = self._repository.persist(
            content_sha256=checksum,
            storage_ref=storage_ref,
            barcode_raw=cmd.barcode_raw,
            client_captured_at=cmd.client_captured_at,
            principal=cmd.principal,
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
