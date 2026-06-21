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
