"""Ports for the ingestion application layer.

Framework-free: stdlib + typing only (no SQLAlchemy/psycopg/HTTP — enforced by
G-ARCH application-purity). Adapters in the adapters layer implement these.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class RawStore(Protocol):
    """Durable object store for raw payload bytes (content-addressed)."""

    def put(self, content: bytes, *, checksum: str) -> str:
        """Persist bytes durably (fsync) under a content-addressed key and return
        the storage ref. MUST be durable before it returns, and idempotent:
        putting identical content twice is a no-op that returns the same ref."""
        ...

    def exists(self, *, checksum: str) -> bool: ...


@dataclass(frozen=True)
class PersistResult:
    ingestion_id: str
    created: bool  # False => this was an idempotent replay of an existing ingestion


@dataclass(frozen=True)
class AuditContext:
    actor_id: str
    correlation_id: str
    trace_id: str


class IngestionWriteRepository(Protocol):
    """Durably records an ingestion + its raw artifact in ONE transaction, with
    the audit context set so the DB audit trigger fires. Idempotent on the
    content scope hash: a duplicate returns the existing id and writes nothing."""

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
    ) -> PersistResult: ...


@dataclass(frozen=True)
class OverriddenField:
    """The persisted human-validated field, returned for the override response."""

    run_id: str  # the NEW append-only run carrying the human value
    field_name: str
    value: str | None
    validation_status: str
    source: str  # always 'human' here
    combined_confidence: float
    confidence_band: str
    replayed: bool  # True => the latest run already carried this human value (no new run)


class FieldOverrideRepository(Protocol):
    """Records a human override of ONE extracted field as a NEW append-only
    extraction_run (a full copy of the latest run with the one field replaced,
    source='human'). The original run is never mutated (ADR-0003/0005). The audit
    context is set so the run's AFTER INSERT audit trigger fires.

    Returns None when the ingestion has no extraction run to override (→ 404).
    Idempotent twice over: (a) VALUE — if the latest run already carries this exact
    human value, no new run is written (replayed=True); (b) KEY — when the client
    supplies an idempotency_key, a repeat of that key (per actor) replays the run
    the ORIGINAL request produced, even if the field has since changed again."""

    def override_field(
        self,
        *,
        ingestion_id: str,
        field_name: str,
        value: str | None,
        note: str | None,
        audit: AuditContext,
        action: str,
        idempotency_key: str | None = None,
    ) -> OverriddenField | None: ...


@dataclass(frozen=True)
class ConfirmedIngestion:
    """Outcome of a reviewer confirming an ingestion (terminal review state)."""

    ingestion_id: str
    status: str  # 'confirmed'
    replayed: bool  # True => it was already confirmed (idempotent repeat)


class ConfirmNotAllowed(Exception):
    """The ingestion is not in a review-ready state (still processing, or failed) —
    confirming it would assert a review that never happened (→ 409)."""

    def __init__(self, status: str) -> None:
        super().__init__(status)
        self.status = status


class ConfirmIngestionRepository(Protocol):
    """Finalizes the review: transitions a review-ready ingestion
    (extracted / needs_review / ocr_skipped_garbage) to 'confirmed', audited.
    Idempotent: an already-confirmed ingestion replays (no write). Returns None
    when the ingestion does not exist (→ 404); raises ConfirmNotAllowed for any
    other state (→ 409)."""

    def confirm(
        self, *, ingestion_id: str, audit: AuditContext, action: str
    ) -> ConfirmedIngestion | None: ...
