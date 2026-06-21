"""PG-5 proofs (pure domain) — the HACCP rules engine."""

from __future__ import annotations

from datetime import date

from labelscan.contexts.haccp.domain.control import (
    AlertType,
    ControlPlan,
    Severity,
    check_expiry,
    check_temperature,
)

PLAN = ControlPlan(
    version="test", max_temp_c=4.0, min_temp_c=-2.0, expiry_warning_days=7
)


def test_temperature_above_max_violates():
    v = check_temperature(8.0, PLAN)
    assert (
        v is not None
        and v.alert_type is AlertType.TEMPERATURE
        and v.severity is Severity.HIGH
    )


def test_temperature_below_min_violates():
    assert check_temperature(-5.0, PLAN) is not None


def test_temperature_in_range_ok():
    assert check_temperature(2.0, PLAN) is None


def test_expiry_passed_is_critical():
    v = check_expiry(date(2026, 6, 10), PLAN, today=date(2026, 6, 14))
    assert v is not None and v.severity is Severity.CRITICAL


def test_expiry_approaching_is_high():
    v = check_expiry(date(2026, 6, 20), PLAN, today=date(2026, 6, 18))  # within 7 days
    assert v is not None and v.severity is Severity.HIGH


def test_expiry_far_off_ok():
    assert check_expiry(date(2026, 12, 31), PLAN, today=date(2026, 6, 18)) is None
