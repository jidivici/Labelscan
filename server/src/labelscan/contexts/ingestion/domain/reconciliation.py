"""GS1 ↔ LLM reconciliation (PURE domain — no DB, no framework).

Merges the gate-validated LLM fields with the mathematically-exact GS1 fields into
the final set persisted by the worker.

Design invariants (respect the existing rules engine — we feed it, we don't rewrite it):
  * The anti-fabrication gate (`evaluate`) still runs on the LLM fields untouched.
    GS1 fields BYPASS that gate: they are grounded in the barcode symbology, not in
    the OCR text, so OCR-grounding does not apply to them.
  * Absolute priority on conflict: for a field present in BOTH, the GS1 value WINS
    (lot / expiry / weight / gtin). The losing LLM value is recorded in a warning,
    never silently dropped.
  * Storage invariants are preserved: a non-null value carries provenance +
    source_raw_artifact_id; a null value carries neither (ck_value_requires_provenance
    / ck_evidence_iff_value).
  * The run OUTCOME (extracted / needs_review) is NOT recomputed here — it stays the
    gate's decision. Upgrading the outcome from GS1 trust would modify the rules
    engine and is intentionally out of scope.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from labelscan.contexts.ingestion.domain.extraction import (
    EvaluatedField,
    GateOutcome,
    GateVerdict,
)
from labelscan.contexts.ingestion.domain.gs1 import Gs1Result

# GS1 trust: barcode data is exact.
_GS1_CONFIDENCE = 1.0
_GS1_BAND = "high"


@dataclass(frozen=True)
class ReconciledField:
    """A field ready to persist — superset the worker writes directly."""

    field_name: str
    value: str | None
    evidence: tuple[str, ...] | None
    provenance: dict[str, Any] | None
    source_raw_artifact_id: str | None
    validation_status: str
    warnings: tuple[str, ...]
    llm_confidence: float | None
    ocr_confidence: float | None
    combined_confidence: float
    confidence_band: str  # 'low' | 'medium' | 'high'
    source: str  # 'llm' | 'gs1' | 'human'


def _from_evaluated(ef: EvaluatedField, *, ocr_artifact_id: str) -> ReconciledField:
    """Map a gate-validated LLM field to a persistable field (source='llm')."""
    has_value = ef.value is not None
    provenance: dict[str, Any] | None = None
    if has_value:
        provenance = {
            "raw_artifact_id": ocr_artifact_id,
            "spans": [
                {
                    "page": s.page,
                    "offset_start": s.offset_start,
                    "offset_end": s.offset_end,
                }
                for s in ef.spans
            ],
        }
    return ReconciledField(
        field_name=ef.name,
        value=ef.value,
        evidence=ef.evidence,
        provenance=provenance,
        source_raw_artifact_id=ocr_artifact_id if has_value else None,
        validation_status=ef.validation_status,
        warnings=ef.warnings,
        llm_confidence=ef.llm_confidence,
        ocr_confidence=ef.ocr_confidence,
        combined_confidence=ef.combined_confidence,
        confidence_band=ef.confidence_band.value,
        source="llm",
    )


def _gs1_field(
    field_name: str,
    value: str,
    *,
    ai: str,
    image_artifact_id: str,
    validation_status: str,
    extra_provenance: dict[str, Any] | None = None,
    warnings: tuple[str, ...] = (),
) -> ReconciledField:
    provenance: dict[str, Any] = {"source": "gs1", "ai": ai}
    if extra_provenance:
        provenance.update(extra_provenance)
    return ReconciledField(
        field_name=field_name,
        value=value,
        evidence=(f"GS1 AI {ai}: {value}",),
        provenance=provenance,
        source_raw_artifact_id=image_artifact_id,
        validation_status=validation_status,
        warnings=warnings,
        llm_confidence=None,
        ocr_confidence=None,
        combined_confidence=_GS1_CONFIDENCE,
        confidence_band=_GS1_BAND,
        source="gs1",
    )


def gs1_resolved_field_names(gs1: Gs1Result) -> frozenset[str]:
    """Schema field names that GS1 already resolves — used to focus the LLM prompt."""
    names: set[str] = set()
    if gs1.lot:
        names.add("batch_number")
    if gs1.expiry_date or gs1.best_before:
        names.add("expiry_date")
    if gs1.net_weight_kg is not None:
        names.add("weight")
    if gs1.gtin:
        names.add("gtin")
    if gs1.packaging_date:
        names.add("packaging_date")
    return frozenset(names)


def _gs1_candidates(gs1: Gs1Result, *, image_artifact_id: str) -> list[ReconciledField]:
    out: list[ReconciledField] = []

    if gs1.lot:
        out.append(
            _gs1_field(
                "batch_number",
                gs1.lot,
                ai="10",
                image_artifact_id=image_artifact_id,
                validation_status="present",
            )
        )

    # DLC (AI 17) is the safety-critical date. Fall back to DDM (AI 15) only if no
    # DLC is present, with a warning so it is never mistaken for a use-by date.
    if gs1.expiry_date:
        out.append(
            _gs1_field(
                "expiry_date",
                gs1.expiry_date,
                ai="17",
                image_artifact_id=image_artifact_id,
                validation_status="normalized",
            )
        )
    elif gs1.best_before:
        out.append(
            _gs1_field(
                "expiry_date",
                gs1.best_before,
                ai="15",
                image_artifact_id=image_artifact_id,
                validation_status="normalized",
                warnings=(
                    "DDM (AI 15) utilisée faute de DLC (AI 17) — date de durabilité, pas une limite de consommation",
                ),
            )
        )

    if gs1.gtin:
        gtin_check_digit_warning = tuple(
            warning for warning in gs1.warnings if "Clé de contrôle GTIN" in warning
        )
        out.append(
            _gs1_field(
                "gtin",
                gs1.gtin,
                ai="01",
                image_artifact_id=image_artifact_id,
                # Keep the exact GS1 payload and let the operator see the same green
                # correction cue as an uncertain extraction. It remains saveable.
                validation_status="invalid" if gtin_check_digit_warning else "present",
                warnings=gtin_check_digit_warning,
            )
        )

    if gs1.packaging_date:
        out.append(
            _gs1_field(
                "packaging_date",
                gs1.packaging_date,
                ai="13",
                image_artifact_id=image_artifact_id,
                validation_status="normalized",
            )
        )

    if gs1.net_weight_kg is not None:
        out.append(
            _gs1_field(
                "weight",
                _format_weight(gs1.net_weight_kg),
                ai="310x",
                image_artifact_id=image_artifact_id,
                validation_status="normalized",
                extra_provenance={"unit": "kg"},
            )
        )
    return out


def _format_weight(kg: float) -> str:
    # compact, locale-neutral; trailing zeros trimmed (1.500 -> "1.5", 2.0 -> "2")
    return f"{kg:.3f}".rstrip("0").rstrip(".")


def reconcile(
    evaluated: tuple[EvaluatedField, ...] | list[EvaluatedField],
    gs1: Gs1Result,
    *,
    ocr_artifact_id: str,
    image_artifact_id: str,
) -> list[ReconciledField]:
    """Merge gate-validated LLM fields with GS1 fields. GS1 wins on conflict."""
    by_name: dict[str, ReconciledField] = {
        ef.name: _from_evaluated(ef, ocr_artifact_id=ocr_artifact_id)
        for ef in evaluated
    }

    for gs1_field in _gs1_candidates(gs1, image_artifact_id=image_artifact_id):
        existing = by_name.get(gs1_field.field_name)
        if (
            existing is not None
            and existing.value is not None
            and existing.value != gs1_field.value
        ):
            conflict = (
                f"Conflit OCR/LLM↔GS1 sur {gs1_field.field_name} : "
                f"LLM='{existing.value}' vs GS1='{gs1_field.value}' — résolu en faveur du GS1.",
            )
            gs1_field = ReconciledField(  # noqa: PLW2901 — intentional rebind
                **{**gs1_field.__dict__, "warnings": gs1_field.warnings + conflict}
            )
        by_name[gs1_field.field_name] = gs1_field

    return list(by_name.values())


# A barcode↔print mismatch on these fields is a labelling-integrity anomaly that a
# human MUST see — it forces needs_review even though the stored value is GS1-exact.
_CRITICAL_CONFLICT_FIELDS = frozenset({"batch_number", "expiry_date"})


def adjusted_outcome(
    verdict: GateVerdict, reconciled: list[ReconciledField]
) -> GateOutcome:
    """Recompute the run outcome after GS1 reconciliation (Option Y).

    PURE — does NOT modify the gate (`evaluate`). It only re-derives the
    needs_review/extracted decision from the gate's verdict + the reconciled fields:

      * a required field the gate flagged missing/low-confidence is cleared when GS1
        supplied it exactly;
      * fabrication flags (unverifiable / security_flag) STILL block — a hallucinating
        model deserves a human look even if GS1 corrected the stored value;
      * the date cross-check is re-run on the GS1-exact values;
      * a barcode↔print conflict on lot/DLC FORCES needs_review.

    With no GS1 data this returns exactly `verdict.outcome` (no behaviour change).
    """
    by_name = {f.field_name: f for f in reconciled}
    gs1_ok = {
        n for n, f in by_name.items() if f.source == "gs1" and f.value is not None
    }
    gs1_conflict = {
        n
        for n, f in by_name.items()
        if f.source == "gs1" and any(w.startswith("Conflit") for w in f.warnings)
    }

    # D1 — labelling-integrity conflict on a critical field: always review.
    if gs1_conflict & _CRITICAL_CONFLICT_FIELDS:
        return GateOutcome.NEEDS_REVIEW

    residual = False
    if "no_field_extracted" in verdict.review_reasons and not any(
        field.value is not None for field in reconciled
    ):
        residual = True
    # GS1 clears missing / low-confidence on the fields it supplies exactly.
    if set(verdict.missing_required) - gs1_ok:
        residual = True
    if set(verdict.low_confidence_required) - gs1_ok:
        residual = True
    # D2 — fabrication stays blocking, GS1 or not.
    if verdict.unverifiable or verdict.security_flags:
        residual = True
    # D3 — per-field inconsistencies (minus GS1-resolved) + date cross-check on GS1 values.
    per_field = {
        n
        for n in verdict.inconsistent
        if n not in ("expiry_date", "packaging_date") and n not in gs1_ok
    }
    exp, pkg = by_name.get("expiry_date"), by_name.get("packaging_date")
    date_inconsistent = bool(
        exp and pkg and exp.value and pkg.value and exp.value < pkg.value
    )
    if per_field or date_inconsistent:
        residual = True

    return GateOutcome.NEEDS_REVIEW if residual else GateOutcome.EXTRACTED
