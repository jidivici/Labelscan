"""Traceability domain-truth checks (pure domain).

A second validation layer, distinct from the extraction gate: it checks the
business consistency of a candidate batch. Cross-record checks that need the
registry (e.g. same lot under a different supplier) are supplied as already-
resolved facts by the caller, keeping this function pure.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

_PRODUCTION_METHODS = frozenset({"wild_caught", "farmed"})


@dataclass(frozen=True)
class BatchCandidate:
    lot_code: str | None
    scientific_name: str | None
    production_method: str | None
    fao_area: str | None
    supplier_name: str | None
    use_by: date | None
    packaging_date: date | None


def check_consistency(
    candidate: BatchCandidate,
    *,
    conflicting_supplier_for_lot: str
    | None = None,  # a different supplier already on this lot
) -> tuple[str, ...]:
    """Return a tuple of inconsistency codes. Empty => consistent."""
    issues: list[str] = []

    if not candidate.lot_code:
        issues.append("missing_lot_code")
    if not candidate.supplier_name:
        issues.append("missing_supplier")

    if (
        candidate.use_by
        and candidate.packaging_date
        and candidate.use_by < candidate.packaging_date
    ):
        issues.append("expiry_before_packaging")

    if (
        candidate.production_method
        and candidate.production_method not in _PRODUCTION_METHODS
    ):
        issues.append("invalid_production_method")

    # supplier mismatch: the same lot code already exists under a DIFFERENT supplier
    if (
        conflicting_supplier_for_lot is not None
        and candidate.supplier_name is not None
        and conflicting_supplier_for_lot != candidate.supplier_name
    ):
        issues.append("supplier_mismatch")

    return tuple(issues)
