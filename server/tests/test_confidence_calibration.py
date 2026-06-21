"""Confidence configuration + calibration harness — pure, NO DB.

Covers (1) env-driven Thresholds (defaults preserve behaviour; validation) and
(2) the calibration recommendation logic (lowest cutoff with zero dangerous
auto-accepts).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from labelscan.app.extraction_wiring import thresholds_from_env

# Import the offline harness from scripts/ (not part of the runtime package).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import calibrate_confidence as cal  # noqa: E402

# ── env-driven thresholds ────────────────────────────────────────────────────


def test_defaults_preserve_current_behaviour(monkeypatch):
    for k in (
        "LABELSCAN_REVIEW_BELOW",
        "LABELSCAN_BAND_MEDIUM_AT",
        "LABELSCAN_BAND_HIGH_AT",
    ):
        monkeypatch.delenv(k, raising=False)
    t = thresholds_from_env()
    assert (t.review_below, t.medium_at, t.high_at) == (0.70, 0.70, 0.90)


def test_review_below_overridable(monkeypatch):
    monkeypatch.setenv("LABELSCAN_REVIEW_BELOW", "0.85")
    assert thresholds_from_env().review_below == 0.85


def test_invalid_value_is_rejected(monkeypatch):
    monkeypatch.setenv("LABELSCAN_REVIEW_BELOW", "1.5")
    with pytest.raises(RuntimeError):
        thresholds_from_env()


def test_medium_must_not_exceed_high(monkeypatch):
    monkeypatch.setenv("LABELSCAN_BAND_MEDIUM_AT", "0.95")
    monkeypatch.setenv("LABELSCAN_BAND_HIGH_AT", "0.90")
    with pytest.raises(RuntimeError):
        thresholds_from_env()


# ── calibration recommendation ───────────────────────────────────────────────

_DATA = [
    {
        "field": "scientific_name",
        "ground_truth": "A",
        "llm_value": "A",
        "llm_confidence": 0.95,
    },
    {
        "field": "scientific_name",
        "ground_truth": "A",
        "llm_value": "B",
        "llm_confidence": 0.80,
    },  # WRONG
    {
        "field": "scientific_name",
        "ground_truth": "C",
        "llm_value": "C",
        "llm_confidence": 0.90,
    },
    {
        "field": "scientific_name",
        "ground_truth": "D",
        "llm_value": None,
        "llm_confidence": 0.10,
    },
]


def test_recommends_lowest_safe_threshold():
    # The wrong value (conf 0.80) is auto-accepted at 0.80 but reviewed at 0.85
    # → lowest cutoff with zero dangerous auto-accepts is 0.85.
    recommended, _ = cal.recommend_review_below(_DATA, target_dangerous=0)
    assert recommended == 0.85


def test_no_safe_threshold_when_wrong_value_is_overconfident():
    data = [
        {"field": "x", "ground_truth": "A", "llm_value": "B", "llm_confidence": 0.99}
    ]
    recommended, rows = cal.recommend_review_below(data, target_dangerous=0)
    assert recommended is None
    assert (
        rows[-1]["dangerous_auto_accepts"] == 1
    )  # still dangerous even at the top of the grid


def test_review_rate_increases_with_threshold():
    rows = cal.analyse(_DATA)
    assert rows[0]["review_rate"] <= rows[-1]["review_rate"]
