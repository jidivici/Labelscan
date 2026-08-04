"""PG-4 proofs (pure domain) — the validation gate.

No DB. Proves the no-fabrication trust boundary and the validation gates in
isolation: missing required, low confidence, inconsistent/out-of-vocab, and that
ANY defect routes to needs_review (no silent acceptance).
"""

from __future__ import annotations

from labelscan.contexts.ingestion.domain.extraction import (
    GateOutcome,
    RuleSet,
    evaluate,
)
from tests._fakes import OCR_TEXT, field, good_fields

RULES = RuleSet(
    version="test",
    required_fields=frozenset({"scientific_name", "expiry_date", "production_method"}),
)


def _by(verdict, name):
    return next(f for f in verdict.fields if f.name == name)


def test_happy_path_extracted_with_provenance():
    v = evaluate(good_fields(), ocr_text=OCR_TEXT, ocr_confidence=0.95, rule_set=RULES)
    assert v.outcome is GateOutcome.EXTRACTED
    assert not v.review_reasons
    sci = _by(v, "scientific_name")
    assert sci.value == "Gadus morhua"
    assert (
        sci.spans and sci.spans[0].offset_end > sci.spans[0].offset_start
    )  # provenance computed
    assert sci.combined_confidence > 0


def test_fabricated_value_is_coerced_to_null_and_flagged():
    fields = (
        field(
            "scientific_name", "Thunnus thynnus", 0.99, ["Thunnus thynnus"]
        ),  # NOT in OCR_TEXT
        field("expiry_date", "2026-06-20", 0.95, ["2026-06-20"]),
        field("production_method", "wild_caught", 0.93, ["Wild caught"]),
    )
    v = evaluate(fields, ocr_text=OCR_TEXT, ocr_confidence=0.95, rule_set=RULES)
    assert v.outcome is GateOutcome.NEEDS_REVIEW
    sci = _by(v, "scientific_name")
    assert sci.value is None  # no fabrication: ungrounded value dropped
    assert "scientific_name" in v.unverifiable
    assert "EVIDENCE_NOT_IN_RAW_OCR" in v.security_flags


def test_missing_required_field_routes_to_review():
    fields = (
        field("scientific_name", "Gadus morhua", 0.96, ["Gadus morhua"]),
        field("production_method", "wild_caught", 0.93, ["Wild caught"]),
        # expiry_date omitted entirely
    )
    v = evaluate(fields, ocr_text=OCR_TEXT, ocr_confidence=0.95, rule_set=RULES)
    assert v.outcome is GateOutcome.NEEDS_REVIEW
    assert "expiry_date" in v.missing_required


def test_low_confidence_required_field_routes_to_review():
    fields = (
        field("scientific_name", "Gadus morhua", 0.40, ["Gadus morhua"]),  # low
        field("expiry_date", "2026-06-20", 0.95, ["2026-06-20"]),
        field("production_method", "wild_caught", 0.93, ["Wild caught"]),
    )
    v = evaluate(fields, ocr_text=OCR_TEXT, ocr_confidence=0.95, rule_set=RULES)
    assert v.outcome is GateOutcome.NEEDS_REVIEW
    assert "scientific_name" in v.low_confidence_required


def test_out_of_vocab_production_method_is_inconsistent():
    fields = (
        field("scientific_name", "Gadus morhua", 0.96, ["Gadus morhua"]),
        field("expiry_date", "2026-06-20", 0.95, ["2026-06-20"]),
        field(
            "production_method", "ranched", 0.93, ["Wild caught"]
        ),  # grounded evidence, bad value
    )
    v = evaluate(fields, ocr_text=OCR_TEXT, ocr_confidence=0.95, rule_set=RULES)
    assert v.outcome is GateOutcome.NEEDS_REVIEW
    assert "production_method" in v.inconsistent


def test_null_value_field_drops_evidence_to_satisfy_storage_invariant():
    # Real-world trigger: the model declined to pick between two conflicting lot
    # numbers (GS1 barcode vs printed text) -> value=None but evidence carries both
    # candidates. The storage invariant ck_evidence_iff_value forbids evidence
    # without a value, so evidence/spans are dropped here; the conflict survives in
    # warnings + validation_status. (Regression: this previously hit a DB
    # CheckViolation in the extraction worker.)
    fields = (
        *good_fields(),
        field(
            "batch_number",
            None,
            0.30,
            ["(01)3700161210047(7030)25017300147(10)2548541", "LOT 2540541"],
            status="ambiguous",
            warnings=[
                "Two conflicting lot values found: '2548541' (GS1 AI 10) and 'LOT 2540541'"
            ],
        ),
    )
    v = evaluate(fields, ocr_text=OCR_TEXT, ocr_confidence=0.95, rule_set=RULES)
    batch = _by(v, "batch_number")
    assert batch.value is None
    assert batch.evidence is None  # invariant: evidence exists iff value exists
    assert batch.spans == ()
    assert batch.validation_status == "ambiguous"  # the conflict is still recorded
    assert batch.warnings  # ...and so are its details
    assert batch.combined_confidence == 0.0


def test_inconsistent_dates_routes_to_review():
    fields = (
        field("scientific_name", "Gadus morhua", 0.96, ["Gadus morhua"]),
        field("expiry_date", "2026-06-10", 0.95, ["2026-06-10"]),  # before packaging
        field("packaging_date", "2026-06-20", 0.95, ["2026-06-20"]),
        field("production_method", "wild_caught", 0.93, ["Wild caught"]),
    )
    v = evaluate(fields, ocr_text=OCR_TEXT, ocr_confidence=0.95, rule_set=RULES)
    assert v.outcome is GateOutcome.NEEDS_REVIEW
    assert "expiry_date" in v.inconsistent
