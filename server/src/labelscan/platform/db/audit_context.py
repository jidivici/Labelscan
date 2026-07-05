"""Transaction-local audit context (infrastructure / platform layer).

The audit trail is written by a DB-level ``AFTER INSERT`` trigger
(``platform.audit_on_insert``) that reads four transaction-local settings:

    labelscan.actor_id        (uuid)  — who performed the action
    labelscan.action          (text)  — the business action name
    labelscan.correlation_id  (text)  — request correlation id
    labelscan.trace_id        (text)  — distributed-trace id

If any of these is unset when a row is inserted into an audited table, the
trigger RAISEs and the whole transaction aborts. That is what makes audit
*unbypassable*: you cannot insert a business row without first declaring who
did it and why — and the audit row is written atomically in the same
transaction by the database itself, not by trusting application code.

These are set with ``set_config(..., is_local => true)`` so they are scoped to
the current transaction and reset automatically on COMMIT/ROLLBACK.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import text
from sqlalchemy.engine import Connection

_SET_LOCAL = text(
    "SELECT "
    "set_config('labelscan.actor_id',       :actor_id,       true), "
    "set_config('labelscan.action',         :action,         true), "
    "set_config('labelscan.correlation_id', :correlation_id, true), "
    "set_config('labelscan.trace_id',       :trace_id,       true)"
)


def set_audit_context(
    conn: Connection,
    *,
    actor_id: str,
    action: str,
    correlation_id: str,
    trace_id: str,
) -> None:
    """Set the transaction-local audit context on an open connection.

    Must be called inside an active transaction, before any insert into an
    audited table.
    """
    conn.execute(
        _SET_LOCAL,
        {
            "actor_id": actor_id,
            "action": action,
            "correlation_id": correlation_id,
            "trace_id": trace_id,
        },
    )


@contextmanager
def audited_transaction(
    conn: Connection,
    *,
    actor_id: str,
    action: str,
    correlation_id: str,
    trace_id: str,
) -> Iterator[Connection]:
    """Open a transaction with the audit context already established.

    Commits on success, rolls back on exception — and because the audit row is
    part of the same transaction, a rollback removes the business row and its
    audit row together.
    """
    with conn.begin():
        set_audit_context(
            conn,
            actor_id=actor_id,
            action=action,
            correlation_id=correlation_id,
            trace_id=trace_id,
        )
        yield conn
