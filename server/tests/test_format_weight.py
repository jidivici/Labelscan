"""Unit proofs for _format_weight edge cases — pure domain, NO database."""

from __future__ import annotations

from labelscan.contexts.ingestion.domain.reconciliation import _format_weight


def test_zero():
    assert _format_weight(0.0) == "0"


def test_small_decimal():
    assert _format_weight(0.001) == "0.001"


def test_trailing_zeros_stripped():
    assert _format_weight(1.500) == "1.5"


def test_integer_kg():
    assert _format_weight(1000.0) == "1000"


def test_very_small():
    assert _format_weight(0.0005) == "0.001"
