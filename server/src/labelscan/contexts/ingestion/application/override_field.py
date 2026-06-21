"""OverrideField use case — record a human-validated correction (HITL, Capability 4).

A reviewer confirms or corrects ONE extracted field. The correction is persisted on
the AUTHORITATIVE backend store (not just the device), append-only and auditable, with
``source='human'`` — closing the cohérence gap where validated values lived only in the
mobile's AsyncStorage (audit §4.2). The original machine run is never overwritten
(ADR-0003): the repository writes a NEW extraction_run that copies the latest run with
this one field replaced.

Pure application logic: it validates the field is human-editable, then delegates the
append-only write to the ``FieldOverrideRepository`` port (no SQL/HTTP here, G-ARCH).
"""

from __future__ import annotations

from dataclasses import dataclass

from labelscan.contexts.ingestion.application.ports import (
    AuditContext,
    FieldOverrideRepository,
    OverriddenField,
)

_ACTION = "ingestion.field_overridden"

# The 16 canonical extraction field names — mirror of the extracted_field.field_name
# CHECK (migration 0008) and the LLM adapter's _FIELD_NAMES. Kept here so an unknown
# field is rejected before the DB is ever touched.
FIELD_NAMES: frozenset[str] = frozenset(
    {
        "product_name",
        "commercial_designation",
        "scientific_name",
        "batch_number",
        "supplier_name",
        "origin_country",
        "FAO_area",
        "production_method",
        "fishing_gear_or_farming_method",
        "expiry_date",
        "packaging_date",
        "storage_temperature",
        "allergens",
        "weight",
        "price",
        "gtin",
    }
)

# GS1-owned fields are read from the barcode symbology (mathematically exact), never
# from OCR/LLM. A human may NOT silently override them: a barcode↔print mismatch is a
# labelling-integrity anomaly that must surface as needs_review, never be "fixed" by a
# manual edit (mirrors extraction_consumer._GS1_OWNED_FIELDS + the reconciliation
# doctrine where GS1 wins on lot/DLC/weight/GTIN/packaging).
GS1_OWNED_FIELDS: frozenset[str] = frozenset(
    {"batch_number", "expiry_date", "weight", "gtin", "packaging_date"}
)


def is_human_editable(field_name: str) -> bool:
    """True iff a reviewer may override this field (a known, non-GS1-owned field)."""
    return field_name in FIELD_NAMES and field_name not in GS1_OWNED_FIELDS


class UnknownField(Exception):
    """The field name is not one of the 16 canonical extraction fields (→ 400)."""


class FieldNotEditable(Exception):
    """The field is GS1-owned and cannot be overridden by a human (→ 409)."""


class IngestionNotFound(Exception):
    """No extraction run exists for this ingestion to override (→ 404)."""


@dataclass(frozen=True)
class OverrideFieldCommand:
    ingestion_id: str
    field_name: str
    value: str | None  # None or empty => the reviewer cleared the field
    note: str | None
    actor_id: str  # authenticated reviewer (recorded as the human provenance + audit actor)
    correlation_id: str
    trace_id: str


class OverrideField:
    def __init__(self, repository: FieldOverrideRepository) -> None:
        self._repository = repository

    def __call__(self, cmd: OverrideFieldCommand) -> OverriddenField:
        if cmd.field_name not in FIELD_NAMES:
            raise UnknownField(cmd.field_name)
        if cmd.field_name in GS1_OWNED_FIELDS:
            raise FieldNotEditable(cmd.field_name)

        # Normalize: a blank string is a cleared field (value=null), consistent with
        # the storage invariant (a null value carries no provenance).
        value = cmd.value.strip() if cmd.value and cmd.value.strip() else None

        result = self._repository.override_field(
            ingestion_id=cmd.ingestion_id,
            field_name=cmd.field_name,
            value=value,
            note=cmd.note,
            audit=AuditContext(
                actor_id=cmd.actor_id,
                correlation_id=cmd.correlation_id,
                trace_id=cmd.trace_id,
            ),
            action=_ACTION,
        )
        if result is None:
            raise IngestionNotFound(cmd.ingestion_id)
        return result
