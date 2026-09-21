"""Unit proofs for Option Y — GS1-aware outcome adjustment. Pure domain, NO DB.

The gate (`evaluate`) is untouched; `adjusted_outcome` re-derives needs_review /
extracted from the gate verdict + the reconciled (GS1) fields.
"""

from __future__ import annotations

from labelscan.contexts.ingestion.domain.extraction import (
    ConfidenceBand,
    EvaluatedField,
    GateOutcome,
    GateVerdict,
    Span,
)
from labelscan.contexts.ingestion.domain.gs1 import parse_gs1
from labelscan.contexts.ingestion.domain.reconciliation import (
    adjusted_outcome,
    reconcile,
)

OCR_AID, IMG_AID = "ocr-1", "img-1"


def _ef(name, value):
    has = value is not None
    return EvaluatedField(
        name=name,
        value=value,
        evidence=(value,) if has else None,
        spans=(Span(page=1, offset_start=0, offset_end=len(value)),) if has else (),
        validation_status="present" if has else "missing",
        warnings=(),
        llm_confidence=0.9,
        ocr_confidence=0.95,
        combined_confidence=0.9 if has else 0.0,
        confidence_band=ConfidenceBand.HIGH if has else ConfidenceBand.LOW,
    )


def _verdict(
    *, missing=(), low=(), unverif=(), inconsistent=(), security=(), fields=()
):
    reasons = []
    if missing:
        reasons.append("missing_required_field")
    if low:
        reasons.append("low_confidence_required_field")
    if unverif:
        reasons.append("unverifiable_field")
    if inconsistent:
        reasons.append("inconsistent_value")
    if security:
        reasons.append("security_flag")
    return GateVerdict(
        outcome=GateOutcome.NEEDS_REVIEW if reasons else GateOutcome.EXTRACTED,
        fields=fields,
        missing_required=missing,
        low_confidence_required=low,
        unverifiable=unverif,
        inconsistent=inconsistent,
        security_flags=security,
        review_reasons=tuple(reasons),
    )


def _rec(evaluated, barcode):
    return reconcile(
        evaluated,
        parse_gs1(barcode),
        ocr_artifact_id=OCR_AID,
        image_artifact_id=IMG_AID,
    )


def test_gs1_clears_missing_required_to_extracted():
    verdict = _verdict(missing=("batch_number",))
    reconciled = _rec((), "(10)2548541")  # GS1 supplies the lot the LLM missed
    assert adjusted_outcome(verdict, reconciled) is GateOutcome.EXTRACTED


def test_gs1_clears_low_confidence_required():
    verdict = _verdict(low=("expiry_date",))
    # LLM read it low-confidence; GS1 confirms the SAME value (no conflict) -> cleared.
    reconciled = _rec((_ef("expiry_date", "2025-12-31"),), "(17)251231")
    assert adjusted_outcome(verdict, reconciled) is GateOutcome.EXTRACTED


def test_conflict_on_lot_forces_review():  # D1
    verdict = _verdict()  # gate found nothing wrong
    reconciled = _rec(
        (_ef("batch_number", "2540541"),), "(10)2548541"
    )  # barcode != print
    assert adjusted_outcome(verdict, reconciled) is GateOutcome.NEEDS_REVIEW


def test_fabrication_stays_blocking_even_if_gs1_resolves():  # D2
    verdict = _verdict(unverif=("expiry_date",), security=("EVIDENCE_NOT_IN_RAW_OCR",))
    reconciled = _rec((), "(17)251231")  # GS1 provides expiry, but the LLM fabricated
    assert adjusted_outcome(verdict, reconciled) is GateOutcome.NEEDS_REVIEW


def test_gs1_dates_recomputed_inconsistent_forces_review():  # D3
    verdict = _verdict()
    reconciled = _rec(
        (), "(17)250101(13)250601"
    )  # expiry 2025-01-01 < packaging 2025-06-01
    assert adjusted_outcome(verdict, reconciled) is GateOutcome.NEEDS_REVIEW


def test_gs1_consistent_dates_clear_inherited_inconsistency():  # D3
    verdict = _verdict(inconsistent=("expiry_date",))  # OCR dates were inconsistent
    reconciled = _rec(
        (), "(17)251231(13)250101"
    )  # GS1: expiry 2025-12-31 > packaging 2025-01-01
    assert adjusted_outcome(verdict, reconciled) is GateOutcome.EXTRACTED


def test_no_barcode_is_passthrough():
    verdict = _verdict(missing=("scientific_name",))
    assert adjusted_outcome(verdict, _rec((), None)) is GateOutcome.NEEDS_REVIEW
    assert adjusted_outcome(_verdict(), _rec((), None)) is GateOutcome.EXTRACTED


def test_llm_only_unmet_requirement_stays_review():
    # GS1 fills the lot, but scientific_name (LLM-only) is still missing.
    verdict = _verdict(missing=("scientific_name", "batch_number"))
    reconciled = _rec((), "(10)2548541")
    assert adjusted_outcome(verdict, reconciled) is GateOutcome.NEEDS_REVIEW


def test_out_of_vocab_field_not_resolved_by_gs1_stays_review():
    verdict = _verdict(inconsistent=("production_method",))
    reconciled = _rec((), "(10)2548541")  # GS1 doesn't touch production_method
    assert adjusted_outcome(verdict, reconciled) is GateOutcome.NEEDS_REVIEW
