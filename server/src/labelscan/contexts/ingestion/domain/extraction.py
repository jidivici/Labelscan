"""Extraction domain — value objects + the validation gate (the trust boundary).

PURE: stdlib only (no SDK, no DB, no frameworks — enforced by G-ARCH domain-purity).
This is the ONLY place that decides whether model output may become a stored,
"valid" result. It never fabricates: a value it cannot ground in the raw OCR text
is coerced to null, and any defect routes the whole run to human review.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import StrEnum


class GateOutcome(StrEnum):
    EXTRACTED = "extracted"
    NEEDS_REVIEW = "needs_review"


class ConfidenceBand(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


# Controlled vocabulary (the only values the gate will accept for these fields).
_PRODUCTION_METHODS = frozenset({"wild_caught", "farmed"})


@dataclass(frozen=True)
class LlmField:
    """What the LLM proposed for one field (provider-agnostic, pre-validation)."""

    name: str
    value: str | None
    llm_confidence: float
    evidence: tuple[str, ...]  # exact substrings the model claims to have read
    validation_status: str  # the model's self-assessment (advisory only)
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class Span:
    page: int
    offset_start: int
    offset_end: int


@dataclass(frozen=True)
class EvaluatedField:
    name: str
    value: str | None
    evidence: tuple[str, ...] | None
    spans: tuple[Span, ...]  # provenance: where in the OCR text the evidence sits
    validation_status: str
    warnings: tuple[str, ...]
    llm_confidence: float
    ocr_confidence: float
    combined_confidence: float
    confidence_band: ConfidenceBand


@dataclass(frozen=True)
class RuleSet:
    """Which fields are mandatory. Supplied as DATA (versioned, owned by Compliance,
    carried BLOCKER B2) — NEVER hard-coded regulatory truth."""

    version: str
    required_fields: frozenset[str]
    allowed_fields: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Thresholds:
    review_below: float = (
        0.70  # combined confidence below this on a required field -> review
    )
    high_at: float = 0.90
    medium_at: float = 0.70


@dataclass(frozen=True)
class OcrQualityPolicy:
    """Thresholds for the OCR-quality gate (a cost saver, NOT a trust boundary).

    An image whose OCR text is (near-)empty, almost entirely non-alphanumeric, or —
    when the provider reported a confidence at all — scored very low, is treated as
    'garbage': not worth an LLM call. Deliberately CONSERVATIVE (biased to proceed)
    so a false skip only routes to review, never fabricates or drops data. Supplied as
    configuration (read from env in the composition root), never hard-coded truth."""

    min_chars: int = 6
    min_alnum_chars: int = 6
    min_mean_confidence: float = 0.15


def is_ocr_garbage(
    full_text: str,
    mean_confidence: float,
    policy: OcrQualityPolicy = OcrQualityPolicy(),
) -> bool:
    """True when the OCR text is too poor to be worth an LLM extraction call.

    PURE (stdlib only). Bias is toward False (proceed): only clearly-unusable reads
    are flagged. A reported confidence is trusted ONLY when > 0 — Google Vision returns
    0.0 when it reports no page confidence at all (see the OCR adapter), so a legible
    but unscored read must NOT be skipped on a 0.0."""
    text = (full_text or "").strip()
    if len(text) < policy.min_chars:
        return True
    alnum = sum(1 for ch in text if ch.isalnum())
    if alnum < policy.min_alnum_chars:
        return True
    if 0.0 < mean_confidence < policy.min_mean_confidence:
        return True
    return False


@dataclass(frozen=True)
class GateVerdict:
    outcome: GateOutcome
    fields: tuple[EvaluatedField, ...]
    missing_required: tuple[str, ...] = ()
    low_confidence_required: tuple[str, ...] = ()
    unverifiable: tuple[str, ...] = ()
    inconsistent: tuple[str, ...] = ()
    security_flags: tuple[str, ...] = ()
    review_reasons: tuple[str, ...] = field(default=())


def _band(c: float, t: Thresholds) -> ConfidenceBand:
    if c >= t.high_at:
        return ConfidenceBand.HIGH
    if c >= t.medium_at:
        return ConfidenceBand.MEDIUM
    return ConfidenceBand.LOW


def _spans_for(
    evidence: tuple[str, ...], ocr_text: str, page: int
) -> tuple[Span, ...] | None:
    """Return provenance spans iff EVERY evidence substring is found verbatim in the
    OCR text. None means at least one piece of evidence is not grounded -> fabrication."""
    spans: list[Span] = []
    for ev in evidence:
        if not isinstance(ev, str) or not ev.strip():
            return None
        idx = ocr_text.find(ev)
        if idx < 0:
            return None
        spans.append(Span(page=page, offset_start=idx, offset_end=idx + len(ev)))
    return tuple(spans)


def evaluate(
    fields: tuple[LlmField, ...],
    *,
    ocr_text: str,
    ocr_confidence: float,
    rule_set: RuleSet,
    thresholds: Thresholds = Thresholds(),
    page: int = 1,
) -> GateVerdict:
    evaluated: list[EvaluatedField] = []
    missing_required: list[str] = []
    low_conf_required: list[str] = []
    unverifiable: list[str] = []
    inconsistent: list[str] = []
    security_flags: list[str] = []

    if not math.isfinite(ocr_confidence) or not 0.0 <= ocr_confidence <= 1.0:
        ocr_confidence = 0.0
        security_flags.append("INVALID_OCR_CONFIDENCE")

    seen_names: set[str] = set()

    for f in fields:
        if rule_set.allowed_fields and f.name not in rule_set.allowed_fields:
            unverifiable.append(f.name)
            security_flags.append("UNEXPECTED_FIELD_NAME")
            continue
        if f.name in seen_names:
            unverifiable.append(f.name)
            security_flags.append("DUPLICATE_FIELD_NAME")
            continue
        seen_names.add(f.name)
        value = f.value
        evidence: tuple[str, ...] | None = f.evidence or None
        spans: tuple[Span, ...] = ()
        vstatus = f.validation_status

        if not math.isfinite(f.llm_confidence) or not 0.0 <= f.llm_confidence <= 1.0:
            value = None
            evidence = None
            vstatus = "invalid"
            unverifiable.append(f.name)
            security_flags.append("INVALID_LLM_CONFIDENCE")

        if value is not None:
            # --- NO FABRICATION: ground every value in the raw OCR text ---
            grounded = _spans_for(f.evidence, ocr_text, page) if f.evidence else None
            if grounded is None:
                # model invented text the OCR never produced -> coerce to null, flag, quarantine
                value = None
                evidence = None
                vstatus = "invalid"
                unverifiable.append(f.name)
                security_flags.append("EVIDENCE_NOT_IN_RAW_OCR")
            else:
                spans = grounded
                # --- consistency / controlled-vocabulary checks ---
                if f.name == "production_method" and value not in _PRODUCTION_METHODS:
                    inconsistent.append(f.name)
                    vstatus = "invalid"
                if (
                    vstatus in ("invalid", "unnormalizable")
                    and f.name not in inconsistent
                ):
                    inconsistent.append(f.name)

        # Storage invariant (ck_evidence_iff_value): evidence exists iff value exists.
        # A null value — e.g. validation_status='ambiguous' (model declined to pick
        # between conflicting candidates), 'missing', or a fabrication coerced to
        # null above — must not carry standalone evidence. The conflicting candidates
        # remain recorded in `warnings`; only `evidence`/`spans` are dropped.
        if value is None:
            evidence = None
            spans = ()

        combined = round(
            min(f.llm_confidence, ocr_confidence) if value is not None else 0.0, 3
        )
        band = _band(combined, thresholds)

        evaluated.append(
            EvaluatedField(
                name=f.name,
                value=value,
                evidence=evidence,
                spans=spans,
                validation_status=vstatus,
                warnings=f.warnings,
                llm_confidence=round(f.llm_confidence, 3),
                ocr_confidence=round(ocr_confidence, 3),
                combined_confidence=combined,
                confidence_band=band,
            )
        )

    # --- cross-field consistency (representative): expiry must not precede packaging ---
    by_name = {e.name: e for e in evaluated}
    exp, pkg = by_name.get("expiry_date"), by_name.get("packaging_date")
    if exp and pkg and exp.value and pkg.value and exp.value < pkg.value:
        inconsistent.append("expiry_date")

    # --- required-field + low-confidence gates ---
    for name in rule_set.required_fields:
        ev = by_name.get(name)
        if ev is None or ev.value is None:
            missing_required.append(name)
        elif ev.combined_confidence < thresholds.review_below:
            low_conf_required.append(name)

    reasons: list[str] = []
    if not any(item.value is not None for item in evaluated):
        reasons.append("no_field_extracted")
    if missing_required:
        reasons.append("missing_required_field")
    if low_conf_required:
        reasons.append("low_confidence_required_field")
    if unverifiable:
        reasons.append("unverifiable_field")
    if inconsistent:
        reasons.append("inconsistent_value")
    if security_flags:
        reasons.append("security_flag")

    outcome = GateOutcome.NEEDS_REVIEW if reasons else GateOutcome.EXTRACTED
    return GateVerdict(
        outcome=outcome,
        fields=tuple(evaluated),
        missing_required=tuple(missing_required),
        low_confidence_required=tuple(low_conf_required),
        unverifiable=tuple(unverifiable),
        inconsistent=tuple(dict.fromkeys(inconsistent)),
        security_flags=tuple(dict.fromkeys(security_flags)),
        review_reasons=tuple(reasons),
    )
