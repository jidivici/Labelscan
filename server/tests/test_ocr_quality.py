"""Unit tests for the OCR-quality gate predicate (PURE — no DB, no providers).

`is_ocr_garbage` decides whether an OCR read is too poor to be worth an LLM call.
It must be CONSERVATIVE: only clearly-unusable reads are skipped, and a legible but
unscored read (Vision returns mean_confidence 0.0 when it reports none) must proceed.
"""

from __future__ import annotations

from labelscan.contexts.ingestion.domain.extraction import (
    OcrQualityPolicy,
    is_ocr_garbage,
)

# A realistic, legible seafood-label OCR read.
LEGIBLE = "Atlantic Cod Gadus morhua FAO 27 Lot L24-0917 Use by 2026-06-20 320 g"


def test_empty_or_whitespace_is_garbage():
    assert is_ocr_garbage("", 0.95) is True
    assert is_ocr_garbage("   \n\t ", 0.95) is True
    assert is_ocr_garbage(None, 0.95) is True  # type: ignore[arg-type]


def test_symbol_noise_is_garbage():
    # Length is fine but there are almost no alphanumeric characters.
    assert is_ocr_garbage("$$ ~~~ ||| .... %%% ## &&", 0.0) is True


def test_legible_text_proceeds_even_when_confidence_is_unscored():
    # Vision returns 0.0 when it reports no page confidence — a legible read must NOT
    # be skipped on that 0.0 (the gate would otherwise drop good labels).
    assert is_ocr_garbage(LEGIBLE, 0.0) is False
    assert is_ocr_garbage(LEGIBLE, 0.95) is False


def test_legible_text_with_a_reported_low_confidence_is_garbage():
    # A confidence that is actually reported (> 0) and very low signals a bad read.
    assert is_ocr_garbage(LEGIBLE, 0.05) is True
    # Just above the floor proceeds.
    assert is_ocr_garbage(LEGIBLE, 0.20) is False


def test_thresholds_are_configurable():
    strict = OcrQualityPolicy(
        min_chars=200, min_alnum_chars=200, min_mean_confidence=0.9
    )
    # A normally-legible read is rejected under a deliberately strict policy.
    assert is_ocr_garbage(LEGIBLE, 0.95, strict) is True

    lax = OcrQualityPolicy(min_chars=1, min_alnum_chars=0, min_mean_confidence=0.0)
    # Pure symbols pass a fully-lax policy (length 1, no alnum floor, no conf floor).
    assert is_ocr_garbage("$$$$$$", 0.0, lax) is False
