"""extracted_field: allow GS1 provenance + GTIN field (hybrid deterministic/LLM extraction)

Revision ID: 0008_gs1_provenance
Revises: 0007_identity_app_user
Create Date: 2026-06-17

HYBRID EXTRACTION (deterministic GS1 + LLM). Two CHECK extensions on
ingestion.extracted_field so barcode-derived (GS1) fields can be persisted with
honest provenance:

  1. source: ('llm','human') -> ('llm','human','gs1'). A 'gs1' field is read from
     the barcode symbology (mathematically exact), not the LLM/OCR.
  2. field_name: add 'gtin' (AI 01 — the product key). All other GS1 AIs map onto
     existing field names (lot->batch_number, AI17->expiry_date, AI310x->weight,
     AI13->packaging_date).

Append-only immutability (row triggers) is untouched — this is DDL on the CHECK
constraints only, the same pattern migration 0005 used to widen raw_artifact.kind.
"""

from __future__ import annotations

from alembic import op

revision = "0008_gs1_provenance"
down_revision = "0007_identity_app_user"
branch_labels = None
depends_on = None

# 0005 field set + 'gtin'.
_FIELD_NAMES = (
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
)
_OLD_FIELD_NAMES = _FIELD_NAMES[:-1]  # without 'gtin'


def _set_field_name_check(names: tuple[str, ...]) -> None:
    joined = ", ".join(f"'{n}'" for n in names)
    op.execute(
        "ALTER TABLE ingestion.extracted_field DROP CONSTRAINT extracted_field_field_name_check"
    )
    op.execute(
        "ALTER TABLE ingestion.extracted_field ADD CONSTRAINT extracted_field_field_name_check "
        f"CHECK (field_name IN ({joined}))"
    )


def _set_source_check(sources: tuple[str, ...]) -> None:
    joined = ", ".join(f"'{s}'" for s in sources)
    op.execute(
        "ALTER TABLE ingestion.extracted_field DROP CONSTRAINT extracted_field_source_check"
    )
    op.execute(
        "ALTER TABLE ingestion.extracted_field ADD CONSTRAINT extracted_field_source_check "
        f"CHECK (source IN ({joined}))"
    )


def upgrade() -> None:
    _set_source_check(("llm", "human", "gs1"))
    _set_field_name_check(_FIELD_NAMES)


def downgrade() -> None:
    _set_field_name_check(_OLD_FIELD_NAMES)
    _set_source_check(("llm", "human"))
