"""Unit proofs for HACCP control-plan edge cases — pure domain, NO database.

Covers null thresholds and boundary conditions not exercised by the main suite.
"""

from __future__ import annotations

from datetime import date, timedelta

from labelscan.contexts.haccp.domain.control import (
    ControlPlan,
    Severity,
    check_expiry,
    check_temperature,
)


def test_temperature_with_both_null_thresholds_returns_none():
    plan = ControlPlan(version="test", max_temp_c=None, min_temp_c=None)
    assert check_temperature(99.0, plan) is None
    assert check_temperature(-99.0, plan) is None


def test_temperature_max_only():
    plan = ControlPlan(version="test", max_temp_c=4.0, min_temp_c=None)
    assert check_temperature(8.0, plan) is not None
    assert check_temperature(-99.0, plan) is None


def test_temperature_min_only():
    plan = ControlPlan(version="test", max_temp_c=None, min_temp_c=-2.0)
    assert check_temperature(-5.0, plan) is not None
    assert check_temperature(99.0, plan) is None


def test_expiry_with_no_warning_days():
    plan = ControlPlan(version="test", expiry_warning_days=None)
    approaching = date.today() + timedelta(days=1)
    assert check_expiry(approaching, plan, today=date.today()) is None
    past = date.today() - timedelta(days=1)
    v = check_expiry(past, plan, today=date.today())
    assert v is not None and v.severity is Severity.CRITICAL


def test_expiry_exactly_on_warning_boundary():
    plan = ControlPlan(version="test", expiry_warning_days=7)
    boundary = date.today() + timedelta(days=7)
    v = check_expiry(boundary, plan, today=date.today())
    assert v is not None and v.severity is Severity.HIGH
