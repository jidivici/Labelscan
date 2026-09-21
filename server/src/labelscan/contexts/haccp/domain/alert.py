"""Alert lifecycle state machine (pure domain).

PURE: stdlib only. The valid-transition rules live here and nowhere else; the
adapter and repository never decide transitions, they only apply this decision.
The lifecycle is monotonic: open -> acknowledged -> resolved (resolve may also
happen directly from open).
"""

from __future__ import annotations

from enum import StrEnum


class AlertState(StrEnum):
    OPEN = "open"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"


class InvalidAlertTransition(Exception):
    def __init__(self, current: AlertState, action: str) -> None:
        self.current = current
        self.action = action
        super().__init__(f"cannot {action} an alert in state '{current.value}'")


def acknowledge(current: AlertState) -> AlertState:
    if current is not AlertState.OPEN:
        raise InvalidAlertTransition(current, "acknowledge")
    return AlertState.ACKNOWLEDGED


def resolve(current: AlertState) -> AlertState:
    if current not in (AlertState.OPEN, AlertState.ACKNOWLEDGED):
        raise InvalidAlertTransition(current, "resolve")
    return AlertState.RESOLVED
