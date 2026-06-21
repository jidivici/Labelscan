"""SQL implementation of AlertRepository (adapter).

One transaction: SELECT ... FOR UPDATE (lock the row), let the domain `decide`
the next state (an InvalidAlertTransition rolls the whole thing back — nothing
changes), set the audit context, then UPDATE. The alert's AFTER UPDATE audit
trigger writes the audit row in the SAME transaction (co-commit), and only when
the audit context is present.
"""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.haccp.application.alert_service import (
    AlertNotFound,
    AlertRepository,
    AuditContext,
)
from labelscan.contexts.haccp.domain.alert import AlertState
from labelscan.platform.db.audit_context import set_audit_context


class SqlAlertRepository(AlertRepository):
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def run_transition(
        self,
        alert_id: str,
        *,
        action: str,
        decide: Callable[[AlertState], AlertState],
        audit: AuditContext,
    ) -> AlertState:
        with self._engine.begin() as conn:
            row = conn.execute(
                text("SELECT state FROM haccp.alert WHERE id = :id FOR UPDATE"),
                {"id": alert_id},
            ).first()
            if row is None:
                raise AlertNotFound(alert_id)

            new_state = decide(
                AlertState(row.state)
            )  # domain rule; may raise -> rollback

            set_audit_context(
                conn,
                actor_id=audit.actor_id,
                action=action,
                correlation_id=audit.correlation_id,
                trace_id=audit.trace_id,
            )
            conn.execute(
                text(
                    "UPDATE haccp.alert SET state = :s, updated_at = clock_timestamp() WHERE id = :id"
                ),
                {"s": new_state.value, "id": alert_id},
            )
        return new_state
