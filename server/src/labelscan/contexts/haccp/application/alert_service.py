"""Alert lifecycle application service + repository port.

Framework-free. The service orchestrates: load current state, let the DOMAIN
decide the next state (rejecting invalid transitions), then persist atomically.
The persistence (and the co-committed audit write) live behind the repository
port — the service holds no SQL.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from labelscan.contexts.haccp.domain.alert import AlertState, acknowledge, resolve


@dataclass(frozen=True)
class AuditContext:
    actor_id: str
    correlation_id: str
    trace_id: str


class AlertNotFound(Exception):
    def __init__(self, alert_id: str) -> None:
        self.alert_id = alert_id
        super().__init__(f"alert {alert_id} not found")


class AlertRepository(Protocol):
    """Applies a domain transition atomically: load current state (locked), run
    `decide` (the domain rule), persist the new state with the audit context set
    so the alert's audit trigger co-commits. Raises AlertNotFound if missing; lets
    the domain's InvalidAlertTransition propagate (and rolls back)."""

    def run_transition(
        self,
        alert_id: str,
        *,
        action: str,
        decide: Callable[[AlertState], AlertState],
        audit: AuditContext,
    ) -> AlertState: ...


class AlertLifecycleService:
    def __init__(self, repository: AlertRepository) -> None:
        self._repository = repository

    def acknowledge(self, alert_id: str, audit: AuditContext) -> AlertState:
        return self._repository.run_transition(
            alert_id, action="haccp.alert_acknowledged", decide=acknowledge, audit=audit
        )

    def resolve(self, alert_id: str, audit: AuditContext) -> AlertState:
        return self._repository.run_transition(
            alert_id, action="haccp.alert_resolved", decide=resolve, audit=audit
        )
