"""Transactional-outbox relay worker (platform / infrastructure).

Decoupling: producers (e.g. ingestion) only INSERT a row into platform.outbox in
their own transaction. This worker is the *only* thing that reads the outbox and
dispatches to consumers. Producers never import this module, so a producer can
never call a consumer directly (enforced by G-ARCH).

Delivery semantics:
  - At-least-once. Each claimable row is locked with FOR UPDATE SKIP LOCKED (safe
    for multiple workers), the registered consumers run, then the row is marked
    published — all in ONE transaction per row. A crash before commit rolls the
    row back to pending, so it is retried. Nothing is lost: the row was written
    atomically with the producer's business write.
  - Idempotent consumers. Each (consumer, event_id) is recorded in
    platform.processed_event; a consumer that has already handled an event is
    skipped on redelivery, so retries cause no duplicate side-effects.

Failure handling (R-B01 — DLQ + exponential backoff):
  - When a handler RAISES (a true "poison pill": malformed payload, an unexpected
    bug — NOT an expected business failure, which a consumer records and returns
    normally), the in-flight transaction rolls back (no partial side-effect, no
    processed_event mark, the row stays pending). The failure is then recorded in
    a SEPARATE transaction: attempts is incremented, the traceback is stored in
    last_error, and the row is either re-scheduled with exponential backoff
    (next_retry_at) or — once attempts reaches MAX_RETRIES — parked in the
    Dead-Letter Queue (status='dead_letter'). The worker does NOT re-raise: it
    keeps draining the rest of the batch, so one poison pill can no longer block
    every other photo (the R-B01 defect).

This worker contains NO business/extraction logic. Consumers are registered by
the composition root (app layer); contexts provide the handlers, keeping this
relay free of any context import.
"""

from __future__ import annotations

import os
import traceback
from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from labelscan.platform.db.tenant_context import set_tenant_context
from labelscan.platform.observability import get_logger
from labelscan.platform.outbox.backoff import (
    DEFAULT_BASE_SECONDS,
    DEFAULT_CAP_SECONDS,
    calculate_backoff,
)
from labelscan.platform.outbox.message import OutboxMessage

_log = get_logger("outbox.worker")

# A handler receives the message and the SAME transaction's connection, so any DB
# side-effect it performs commits atomically with the processed_event mark.
OutboxHandler = Callable[[OutboxMessage, Connection], None]

# After this many failed attempts a poison pill is parked in the DLQ instead of
# being retried again. Overridable via env for ops without a redeploy.
_DEFAULT_MAX_RETRIES = int(os.environ.get("LABELSCAN_OUTBOX_MAX_RETRIES", "3"))

# Claim the oldest claimable row of a type this worker handles. "Claimable" ==
# pending (never published, not dead-lettered) AND past its backoff window.
# FOR UPDATE SKIP LOCKED makes concurrent workers safe; the next_retry_at gate is
# what stops a failing event from being re-claimed before its backoff elapses.
_CLAIM = text(
    "SELECT id, event_type, payload, correlation_id, trace_id "
    "FROM platform.outbox "
    "WHERE published_at IS NULL "
    "  AND status <> 'dead_letter' "
    "  AND (next_retry_at IS NULL OR next_retry_at <= now()) "
    "  AND event_type = ANY(CAST(:types AS text[])) "
    "ORDER BY created_at "
    "FOR UPDATE SKIP LOCKED "
    "LIMIT 1"
)
_SEEN = text(
    "SELECT 1 FROM platform.processed_event WHERE consumer = :c AND event_id = :e"
)
_MARK_PROCESSED = text(
    "INSERT INTO platform.processed_event (consumer, event_id) VALUES (:c, :e)"
)
_MARK_PUBLISHED = text(
    "UPDATE platform.outbox SET status = 'published', published_at = now() "
    "WHERE id = :id"
)
# Re-lock the failed row in its own transaction; the guard skips rows another
# worker has meanwhile published, so a benign race never bumps a healthy row.
_LOCK_FOR_FAILURE = text(
    "SELECT attempts FROM platform.outbox "
    "WHERE id = :id AND status = 'pending' AND published_at IS NULL "
    "FOR UPDATE"
)
_SCHEDULE_RETRY = text(
    "UPDATE platform.outbox "
    "SET attempts = :a, last_error = :e, next_retry_at = :nr WHERE id = :id"
)
_DEAD_LETTER = text(
    "UPDATE platform.outbox "
    "SET attempts = :a, last_error = :e, status = 'dead_letter', next_retry_at = NULL "
    "WHERE id = :id"
)


class OutboxWorker:
    def __init__(
        self,
        engine: Engine,
        *,
        max_retries: int = _DEFAULT_MAX_RETRIES,
        backoff_base_seconds: float = DEFAULT_BASE_SECONDS,
        backoff_cap_seconds: float = DEFAULT_CAP_SECONDS,
    ) -> None:
        self._engine = engine
        self._handlers: dict[str, list[tuple[str, OutboxHandler]]] = {}
        self._max_retries = max_retries
        self._backoff_base_seconds = backoff_base_seconds
        self._backoff_cap_seconds = backoff_cap_seconds

    def register(self, event_type: str, consumer: str, handler: OutboxHandler) -> None:
        self._handlers.setdefault(event_type, []).append((consumer, handler))

    def run_once(self, max_messages: int = 100) -> int:
        """Drain up to max_messages claimable rows. Returns the count of rows handled.

        "Handled" means claimed-and-resolved this pass: either published, or — when
        a handler raised — parked for backoff / dead-lettered. A poison pill is
        therefore counted once and then skipped (its next_retry_at is in the future,
        or it is dead-lettered), so it can neither hot-loop nor block siblings.
        """
        handled = 0
        while handled < max_messages:
            if not self._process_one():
                break
            handled += 1
        return handled

    def _process_one(self) -> bool:
        types = list(self._handlers.keys())
        if not types:
            return False  # a worker only ever claims event types it can handle
        claimed_id: str | None = None
        ctx: dict[str, str] = {}
        try:
            with self._engine.begin() as conn:
                row = conn.execute(_CLAIM, {"types": types}).mappings().first()
                if row is None:
                    return False
                claimed_id = str(row["id"])
                msg = OutboxMessage(
                    id=claimed_id,
                    event_type=row["event_type"],
                    payload=row["payload"],
                    correlation_id=row["correlation_id"],
                    trace_id=row["trace_id"],
                )
                # Business handlers execute under the tenant carried by the
                # immutable event payload. An empty context fails closed for
                # platform-only events and tests. No application-writable GUC
                # can switch RLS into a cross-tenant mode.
                message_organization_id = str(msg.payload.get("organization_id") or "")
                set_tenant_context(conn, message_organization_id)
                ctx = {
                    "event_type": msg.event_type,
                    "correlation_id": msg.correlation_id,
                    "trace_id": msg.trace_id,
                    "organization_id": message_organization_id,
                }
                for consumer, handler in self._handlers.get(msg.event_type, []):
                    if conn.execute(_SEEN, {"c": consumer, "e": msg.id}).first():
                        continue  # idempotent: this consumer already handled this event
                    handler(msg, conn)
                    conn.execute(_MARK_PROCESSED, {"c": consumer, "e": msg.id})
                    _log.info("event_handled", extra={"consumer": consumer, **ctx})
                conn.execute(_MARK_PUBLISHED, {"id": msg.id})
            return True
        except Exception as exc:
            # The atomic transaction above rolled back: no partial side-effect, no
            # processed_event mark, the row is still pending. If we never managed to
            # claim a row, the failure is at the claim/DB level — surface it (the
            # poll loop will back off via its sleep) rather than mask a dead DB.
            if claimed_id is None:
                raise
            # Otherwise it is a handler poison pill: record the failure out-of-band
            # so the row backs off / dead-letters, and KEEP DRAINING the batch.
            self._record_failure(claimed_id, exc, ctx)
            return True

    def _record_failure(
        self, event_id: str, exc: BaseException, ctx: dict[str, str]
    ) -> None:
        """Persist an attempt's failure in its own transaction (backoff or DLQ).

        Committing the failure — instead of only rolling back — is what gives the
        poison pill a memory: without it the row would look brand-new and be
        re-claimed immediately, forever.
        """
        trace = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        with self._engine.begin() as conn:
            locked = conn.execute(_LOCK_FOR_FAILURE, {"id": event_id}).first()
            if locked is None:
                # Another worker published it in the gap, or it is already dead —
                # nothing to record. Benign race; the guard kept us from bumping it.
                return
            attempts = int(locked[0]) + 1
            if attempts >= self._max_retries:
                conn.execute(_DEAD_LETTER, {"a": attempts, "e": trace, "id": event_id})
                _log.error("event_dead_lettered", extra={"attempts": attempts, **ctx})
                return
            next_retry = calculate_backoff(
                attempts,
                now=datetime.now(UTC),
                base_seconds=self._backoff_base_seconds,
                cap_seconds=self._backoff_cap_seconds,
            )
            conn.execute(
                _SCHEDULE_RETRY,
                {"a": attempts, "e": trace, "nr": next_retry, "id": event_id},
            )
            _log.warning(
                "event_retry_scheduled",
                extra={
                    "attempts": attempts,
                    "next_retry_at": next_retry.isoformat(),
                    **ctx,
                },
            )
