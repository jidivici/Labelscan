"""extracted_field: v2 field set — split supplier; add producer/reseller/health_mark

Revision ID: 0011_extraction_fields_v2
Revises: 0010_escalation_columns
Create Date: 2026-06-22

Prompt contract v2.0.0 (claude_llm_provider._PROMPT_VERSION). The closed LLM field
set changed:

  - product_name REMOVED (commercial_designation is now THE designation);
  - supplier_name SPLIT into producer_name (provenance) + reseller_brand
    (marque de revente / FBO);
  - health_mark ADDED (estampille sanitaire — HACCP Reg. 853/2004, previously
    discarded).

ingestion.extracted_field is APPEND-ONLY / immutable (row triggers, migration
0005), so the field_name CHECK is widened to a SUPERSET: the three new names are
ADDED, and legacy 'product_name' / 'supplier_name' are KEPT so the immutable
historical rows written under v1 stay valid (a tightening DROP would fail
validation on existing rows and break append-only replay/restore). DDL on the
CHECK only — same pattern migrations 0005/0008 used.
"""

from __future__ import annotations

from alembic import op

revision = "0011_extraction_fields_v2"
down_revision = "0010_escalation_columns"
branch_labels = None
depends_on = None

# The v1 set (migration 0008: 15 names + 'gtin') — KEPT verbatim so historical rows
# stay valid. 'product_name'/'supplier_name' are no longer EMITTED but stay ALLOWED.
_LEGACY_FIELD_NAMES = (
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
# The three names the v2 LLM output adds (mirror of claude_llm_provider._FIELD_NAMES
# and override_field.FIELD_NAMES).
_V2_ADDED = ("producer_name", "reseller_brand", "health_mark")
_FIELD_NAMES = _LEGACY_FIELD_NAMES + _V2_ADDED


def _set_field_name_check(names: tuple[str, ...]) -> None:
    joined = ", ".join(f"'{n}'" for n in names)
    op.execute(
        "ALTER TABLE ingestion.extracted_field "
        "DROP CONSTRAINT extracted_field_field_name_check"
    )
    op.execute(
        "ALTER TABLE ingestion.extracted_field "
        "ADD CONSTRAINT extracted_field_field_name_check "
        f"CHECK (field_name IN ({joined}))"
    )


def upgrade() -> None:
    _set_field_name_check(_FIELD_NAMES)


def downgrade() -> None:
    # Revert to the v1 (0008) allow-list. Safe only if no v2-only rows exist yet.
    _set_field_name_check(_LEGACY_FIELD_NAMES)
