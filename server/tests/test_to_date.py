"""Unit tests for registration_consumer._to_date — invalid dates must never crash
the consumer (they degrade to None). No DB required."""

from __future__ import annotations

from datetime import date

from labelscan.contexts.traceability.adapters.registration_consumer import (
    _to_date,
    _to_production_method,
)


def test_parses_valid_iso_date():
    assert _to_date("2026-06-20") == date(2026, 6, 20)


def test_none_and_empty_are_none():
    assert _to_date(None) is None
    assert _to_date("") is None


def test_malformed_string_is_none_not_raise():
    # ValueError path: well-typed but not a valid ISO date.
    assert _to_date("20/06/2026") is None
    assert _to_date("not-a-date") is None
    assert _to_date("2026-13-99") is None


def test_non_string_value_is_none_not_raise():
    # TypeError path: date.fromisoformat() rejects non-str input. Must not crash.
    assert _to_date(20260620) is None  # type: ignore[arg-type]
    assert _to_date(["2026-06-20"]) is None  # type: ignore[arg-type]


def test_not_communicated_production_method_maps_to_nullable_registry_value():
    assert _to_production_method("NC") is None
    assert _to_production_method("wild_caught") == "wild_caught"
