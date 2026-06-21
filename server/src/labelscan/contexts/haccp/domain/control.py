"""HACCP control-plan rules engine (pure domain).

PURE: stdlib only. Evaluates critical control points (temperature, expiry) against
a control-plan version. Thresholds are DATA supplied by the caller (Compliance-
owned, versioned) — never hard-coded regulatory truth.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from enum import StrEnum


class AlertType(StrEnum):
    EXPIRY = "expiry"
    TEMPERATURE = "temperature"
    REQUIRED_FIELD = "required_field"
    INCONSISTENCY = "inconsistency"


class Severity(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass(frozen=True)
class ControlPlan:
    version: str
    max_temp_c: float | None = None
    min_temp_c: float | None = None
    expiry_warning_days: int | None = None


@dataclass(frozen=True)
class Violation:
    alert_type: AlertType
    severity: Severity
    detail: dict


def check_temperature(temp_c: float, plan: ControlPlan) -> Violation | None:
    if plan.max_temp_c is not None and temp_c > plan.max_temp_c:
        return Violation(
            AlertType.TEMPERATURE,
            Severity.HIGH,
            {"temp_c": temp_c, "max_temp_c": plan.max_temp_c, "breach": "above_max"},
        )
    if plan.min_temp_c is not None and temp_c < plan.min_temp_c:
        return Violation(
            AlertType.TEMPERATURE,
            Severity.HIGH,
            {"temp_c": temp_c, "min_temp_c": plan.min_temp_c, "breach": "below_min"},
        )
    return None


def check_expiry(use_by: date, plan: ControlPlan, today: date) -> Violation | None:
    if use_by < today:
        return Violation(
            AlertType.EXPIRY,
            Severity.CRITICAL,
            {
                "use_by": use_by.isoformat(),
                "today": today.isoformat(),
                "state": "expired",
            },
        )
    if plan.expiry_warning_days is not None:
        from datetime import timedelta

        if use_by <= today + timedelta(days=plan.expiry_warning_days):
            return Violation(
                AlertType.EXPIRY,
                Severity.HIGH,
                {
                    "use_by": use_by.isoformat(),
                    "today": today.isoformat(),
                    "state": "approaching",
                    "warning_days": plan.expiry_warning_days,
                },
            )
    return None
