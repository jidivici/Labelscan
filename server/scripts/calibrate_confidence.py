#!/usr/bin/env python3
"""Confidence-threshold calibration harness (offline tooling — touches nothing live).

Re-calibration is DATA-DRIVEN, not a guess. This tool derives `review_below` (the
combined-confidence cutoff under which a required field is sent to human review)
from a LABELLED dataset, by the only HACCP-safe criterion: pick the LOWEST cutoff
that produces ZERO dangerous auto-accepts — i.e. no WRONG value is ever
auto-accepted (skipping review). Lower review burden is secondary to that.

Calibrate per model: a cheaper model (Haiku) is usually less precise than Opus, so
its safe cutoff is typically higher.

INPUT — a JSON array of per-(label, field) records for the LLM-only fields you care
about (the fields GS1 cannot supply: scientific_name, commercial_designation, …):

    [
      {"field": "scientific_name", "ground_truth": "Gadus morhua",
       "llm_value": "Gadus morhua", "llm_confidence": 0.93},
      {"field": "scientific_name", "ground_truth": "Gadus morhua",
       "llm_value": "Gadus macrocephalus", "llm_confidence": 0.71},
      ...
    ]

`ground_truth` is the verified correct value (from a human, OR — for lot/DLC/weight
— from the GS1 barcode, which is exact). `llm_value` may be null (model abstained).

USAGE:
    python scripts/calibrate_confidence.py dataset.json
    python scripts/calibrate_confidence.py dataset.json --target-dangerous 0
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

_DEFAULT_GRID = [round(0.50 + 0.05 * i, 2) for i in range(10)]  # 0.50 .. 0.95


def analyse(
    records: list[dict[str, Any]], grid: list[float] | None = None
) -> list[dict[str, Any]]:
    """Per-threshold outcome counts over the labelled records."""
    grid = grid or _DEFAULT_GRID
    total = len(records)
    rows: list[dict[str, Any]] = []
    for t in grid:
        auto = [
            r
            for r in records
            if r.get("llm_value") is not None and float(r["llm_confidence"]) >= t
        ]
        dangerous = sum(
            1 for r in auto if str(r["llm_value"]) != str(r["ground_truth"])
        )
        correct_auto = len(auto) - dangerous
        reviewed = total - len(auto)
        rows.append(
            {
                "threshold": t,
                "auto_accepted": len(auto),
                "correct_auto_accepts": correct_auto,
                "dangerous_auto_accepts": dangerous,  # WRONG value skipped review — must be 0
                "sent_to_review": reviewed,
                "review_rate": round(reviewed / total, 3) if total else 0.0,
            }
        )
    return rows


def recommend_review_below(
    records: list[dict[str, Any]],
    *,
    target_dangerous: int = 0,
    grid: list[float] | None = None,
) -> tuple[float | None, list[dict[str, Any]]]:
    """Return (recommended review_below, analysis rows). Recommendation = lowest
    threshold whose dangerous_auto_accepts <= target_dangerous (None if none qualify)."""
    rows = analyse(records, grid)
    safe = [
        row["threshold"]
        for row in rows
        if row["dangerous_auto_accepts"] <= target_dangerous
    ]
    return (min(safe) if safe else None), rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Calibrate review_below from a labelled dataset."
    )
    parser.add_argument(
        "dataset", help="JSON array of {field, ground_truth, llm_value, llm_confidence}"
    )
    parser.add_argument(
        "--target-dangerous",
        type=int,
        default=0,
        help="max acceptable wrong auto-accepts (default 0 — HACCP-safe)",
    )
    args = parser.parse_args(argv)

    with open(args.dataset, encoding="utf-8") as fh:
        records = json.load(fh)
    if not isinstance(records, list) or not records:
        print("dataset must be a non-empty JSON array", file=sys.stderr)
        return 2

    recommended, rows = recommend_review_below(
        records, target_dangerous=args.target_dangerous
    )

    print(f"{'thr':>5} {'auto':>5} {'ok':>5} {'DANGER':>7} {'review':>7} {'rev%':>6}")
    for r in rows:
        print(
            f"{r['threshold']:>5} {r['auto_accepted']:>5} {r['correct_auto_accepts']:>5} "
            f"{r['dangerous_auto_accepts']:>7} {r['sent_to_review']:>7} {r['review_rate']:>6}"
        )
    print()
    if recommended is None:
        print(
            f"No threshold reaches <= {args.target_dangerous} dangerous auto-accepts on this data."
        )
        print(
            "=> Keep ALL required fields in review for this model, or improve the model/prompt."
        )
        return 1
    print(f"RECOMMENDED LABELSCAN_REVIEW_BELOW = {recommended}")
    print(
        f"  ({len(records)} records, target dangerous auto-accepts <= {args.target_dangerous})"
    )
    print(
        "  Apply via env, and bump the rule-set version so runs record this calibration."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
