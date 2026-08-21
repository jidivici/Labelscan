"""Unit proofs for GS1 ↔ LLM reconciliation — pure domain, NO database.

Proves the zero-hallucination guarantee on critical fields: GS1 (barcode-exact)
always wins over OCR/LLM on lot / DLC, the conflict is recorded, and storage
invariants (provenance iff value) hold for both sources.
"""

from __future__ import annotations

from labelscan.contexts.ingestion.domain.extraction import (
    ConfidenceBand,
    EvaluatedField,
    Span,
)
from labelscan.contexts.ingestion.domain.gs1 import parse_gs1
from labelscan.contexts.ingestion.domain.reconciliation import reconcile

OCR_AID = "ocr-artifact-1"
IMG_AID = "image-artifact-1"


def _ef(name: str, value: str | None, *, conf: float = 0.9) -> EvaluatedField:
    has = value is not None
    return EvaluatedField(
        name=name,
        value=value,
        evidence=(value,) if has else None,
        spans=(Span(page=1, offset_start=0, offset_end=len(value)),) if has else (),
        validation_status="present" if has else "missing",
        warnings=(),
        llm_confidence=conf,
        ocr_confidence=0.95,
        combined_confidence=conf if has else 0.0,
        confidence_band=ConfidenceBand.HIGH if has else ConfidenceBand.LOW,
    )


def _by_name(fields):
    return {f.field_name: f for f in fields}


def test_gs1_overrides_llm_on_lot_conflict():
    # The exact bug scenario: barcode lot vs a different printed/LLM lot.
    evaluated = (_ef("batch_number", "2540541"),)  # LLM read the printed (wrong) lot
    gs1 = parse_gs1("(10)2548541")  # barcode (exact) lot
    out = _by_name(
        reconcile(evaluated, gs1, ocr_artifact_id=OCR_AID, image_artifact_id=IMG_AID)
    )

    lot = out["batch_number"]
    assert lot.value == "2548541"  # GS1 WINS — zero hallucination
    assert lot.source == "gs1"
    assert lot.combined_confidence == 1.0
    assert lot.confidence_band == "high"
    assert lot.source_raw_artifact_id == IMG_AID
    assert lot.provenance == {"source": "gs1", "ai": "10"}
    assert any(
        "Conflit" in w and "2540541" in w for w in lot.warnings
    )  # loser recorded


def test_gs1_adds_expiry_when_llm_missing():
    evaluated = (_ef("scientific_name", "Gadus morhua"),)
    gs1 = parse_gs1("(17)251231")
    out = _by_name(
        reconcile(evaluated, gs1, ocr_artifact_id=OCR_AID, image_artifact_id=IMG_AID)
    )
    assert out["expiry_date"].value == "2025-12-31"
    assert out["expiry_date"].source == "gs1"
    assert out["expiry_date"].validation_status == "normalized"
    # the LLM field passes through untouched
    assert out["scientific_name"].source == "llm"


def test_ddm_fallback_is_warned():
    gs1 = parse_gs1("(15)251231")  # only DDM (AI 15), no DLC (AI 17)
    out = _by_name(
        reconcile((), gs1, ocr_artifact_id=OCR_AID, image_artifact_id=IMG_AID)
    )
    assert out["expiry_date"].value == "2025-12-31"
    assert any("DDM" in w for w in out["expiry_date"].warnings)


def test_weight_and_gtin_from_gs1():
    gs1 = parse_gs1("(01)03700161210047(3103)001500")
    out = _by_name(
        reconcile((), gs1, ocr_artifact_id=OCR_AID, image_artifact_id=IMG_AID)
    )
    assert out["gtin"].value == "03700161210047"
    assert out["weight"].value == "1.5"
    assert out["weight"].provenance == {"source": "gs1", "ai": "310x", "unit": "kg"}


def test_gs1_gtin_with_a_check_digit_warning_remains_saveable_but_needs_review():
    out = _by_name(
        reconcile(
            (),
            parse_gs1("(01)93000502900206"),
            ocr_artifact_id=OCR_AID,
            image_artifact_id=IMG_AID,
        )
    )
    assert out["gtin"].value == "93000502900206"
    assert out["gtin"].validation_status == "invalid"
    assert any("Clé de contrôle" in warning for warning in out["gtin"].warnings)


def test_no_barcode_is_pure_passthrough():
    evaluated = (_ef("batch_number", "LOT9"), _ef("scientific_name", None))
    out = _by_name(
        reconcile(
            evaluated,
            parse_gs1(None),
            ocr_artifact_id=OCR_AID,
            image_artifact_id=IMG_AID,
        )
    )
    assert out["batch_number"].source == "llm"
    assert out["batch_number"].value == "LOT9"
    assert out["batch_number"].source_raw_artifact_id == OCR_AID  # LLM provenance = OCR
    # a null LLM field keeps NO provenance / NO source ref (ck_value_requires_provenance)
    assert out["scientific_name"].value is None
    assert out["scientific_name"].provenance is None
    assert out["scientific_name"].source_raw_artifact_id is None


def test_no_conflict_warning_when_values_agree():
    evaluated = (_ef("batch_number", "2548541"),)  # LLM agrees with barcode
    gs1 = parse_gs1("(10)2548541")
    out = _by_name(
        reconcile(evaluated, gs1, ocr_artifact_id=OCR_AID, image_artifact_id=IMG_AID)
    )
    assert out["batch_number"].value == "2548541"
    assert out["batch_number"].source == "gs1"  # still upgraded to exact source
    assert not any("Conflit" in w for w in out["batch_number"].warnings)
