"""Pure tests for the Tier 3 wave-2 deterministic extractors (interim_fields).

No DB, no providers. The invariants under test:
  * emit ONLY on an explicitly-labelled, unambiguous match (no bare dates);
  * canonical value forms match the LLM contract (ISO date, "0-4 C");
  * several DISTINCT candidates for one field -> field NOT emitted;
  * order-ambiguous numeric dates (both components <=12) are never guessed.
"""

from __future__ import annotations

from labelscan.contexts.ingestion.domain.interim_fields import (
    extract_high_precision_ocr_fields,
    extract_interim_fields,
)


def _as_dict(text: str) -> dict[str, str]:
    return {f.name: f.value for f in extract_interim_fields(text)}


# ── dates ─────────────────────────────────────────────────────────────────────


def test_expiry_date_fr_label_numeric_unambiguous():
    # component >12 fixes the order (prompt-contract rule): 16 = day
    got = _as_dict("POISSONNERIE  A CONSOMMER JUSQU'AU : 16/06/2026  LOT ABC")
    assert got["expiry_date"] == "2026-06-16"


def test_expiry_date_dlc_iso_and_two_digit_year():
    assert _as_dict("DLC 2026-06-20")["expiry_date"] == "2026-06-20"
    assert _as_dict("dlc : 22.06.26")["expiry_date"] == "2026-06-22"


def test_expiry_date_order_ambiguous_is_skipped():
    # 04/05 — both <=12: 4 May vs 5 April. Never guessed.
    assert "expiry_date" not in _as_dict("DLC 04/05/2026")


def test_bare_date_without_label_is_not_attributed():
    assert _as_dict("Pêché le 16/06/2026 en Atlantique") == {}


def test_packaging_date_fr_label():
    got = _as_dict("Emballé le 14/06/2026 — À consommer jusqu'au 20/06/2026")
    assert got["packaging_date"] == "2026-06-14"
    assert got["expiry_date"] == "2026-06-20"


def test_use_by_english_label():
    assert _as_dict("Use by 2026-06-20")["expiry_date"] == "2026-06-20"


def test_two_distinct_expiry_dates_emit_nothing():
    assert "expiry_date" not in _as_dict("DLC 16/06/2026 ... DLC 17/06/2026")


def test_same_expiry_date_twice_is_one_value():
    got = _as_dict("DLC 16/06/2026 (verso: use by 2026-06-16)")
    assert got["expiry_date"] == "2026-06-16"


def test_invalid_date_components_are_rejected():
    assert "expiry_date" not in _as_dict("DLC 32/13/2026")


# ── storage temperature ───────────────────────────────────────────────────────


def test_temperature_entre_range_canonical_form():
    got = _as_dict("À conserver entre 0°C et +4°C")
    assert got["storage_temperature"] == "0-4 C"


def test_temperature_slash_range():
    assert _as_dict("Conservation 0°C / +4°C")["storage_temperature"] == "0-4 C"


def test_temperature_bare_number_not_emitted():
    # "Keep below 4C" has no franc range form — the LLM resolves it, not a regex.
    assert "storage_temperature" not in _as_dict("Keep below 4C")


def test_temperature_negative_range():
    got = _as_dict("entre -18°C et -15°C")
    assert got["storage_temperature"] == "-18--15 C"


# ── batch number ──────────────────────────────────────────────────────────────


def test_batch_number_keeps_original_casing():
    assert _as_dict("Lot: L24-0917 poids net 320 g")["batch_number"] == "L24-0917"


def test_batch_number_no_digit_rejected():
    assert "batch_number" not in _as_dict("Lot: ABC")


def test_batch_number_two_distinct_lots_emit_nothing():
    assert "batch_number" not in _as_dict("LOT A123 ... LOT B456")


# ── sanitary mark + production method ────────────────────────────────────────


def test_health_mark_is_recovered_with_exact_multiline_evidence():
    text = "Origine Espagne\nFR\n07 019 003\nUE\nLot A123"
    fields = {field.name: field for field in extract_high_precision_ocr_fields(text)}
    assert fields["health_mark"].value == "FR 07 019 003 UE"
    assert fields["health_mark"].evidence == "FR\n07 019 003\nUE"
    assert fields["health_mark"].validation_status == "normalized"


def test_health_mark_does_not_confuse_origin_or_date():
    assert "health_mark" not in _as_dict(
        "Origine France\nDLC 20/09/2026\nEmballé en FR"
    )


def test_short_gb_health_mark_without_eu_suffix_is_recovered():
    assert _as_dict("Packed in the UK\nGB BB004")["health_mark"] == "GB BB004"


def test_explicit_elevage_sets_farmed():
    got = _as_dict("Truite arc-en-ciel — Élevée en France")
    assert got["production_method"] == "farmed"


def test_generic_fishing_or_farming_heading_does_not_set_farmed():
    got = _as_dict("Engin de pêche / d'élevage : bassins")
    assert "production_method" not in got


def test_generic_regulatory_boilerplate_does_not_set_farmed():
    got = _as_dict("Produits de la pêche et de l'aquaculture")
    assert "production_method" not in got


# ── general ───────────────────────────────────────────────────────────────────


def test_empty_text_returns_nothing():
    assert extract_interim_fields("") == ()


def test_fixture_ocr_text_yields_expected_wave2():
    # The shared FakeOcr text (tests/_fakes.py): "Use by 2026-06-20 Packed on
    # 2026-06-10 Keep below 4C Lot L24-0917 Net weight 320 g"
    from tests._fakes import OCR_TEXT

    got = _as_dict(OCR_TEXT)
    assert got["expiry_date"] == "2026-06-20"
    assert got["packaging_date"] == "2026-06-10"
    assert got["batch_number"] == "L24-0917"
    assert "storage_temperature" not in got  # "Keep below 4C" is not a franc range
