"""Unit proofs for the GS1 element-string parser — pure domain, NO database."""

from __future__ import annotations

from labelscan.contexts.ingestion.domain.gs1 import FNC1, parse_gs1


def test_parenthesised_gtin_lot_expiry():
    r = parse_gs1("(01)03700161210047(17)251231(10)LOT123")
    assert r.gtin == "03700161210047"
    assert r.lot == "LOT123"
    assert r.expiry_date == "2025-12-31"


def test_supplied_label_keeps_full_ai01_even_with_unusual_check_digit():
    r = parse_gs1(
        "(01)93000502900206(7030)25034108593(10)107083(3103)004500(21)0008186"
    )
    assert r.gtin == "93000502900206"
    assert r.lot == "107083"
    assert r.net_weight_kg == 4.5
    assert any("Clé de contrôle" in warning for warning in r.warnings)


def test_positional_with_fnc1_separators():
    # 01 (fixed 14) + 10 (variable, FNC1-terminated) + 17 (fixed 6)
    raw = "0103700161210047" + "10LOT123" + FNC1 + "17251231"
    r = parse_gs1(raw)
    assert r.gtin == "03700161210047"
    assert r.lot == "LOT123"
    assert r.expiry_date == "2025-12-31"


def test_net_weight_310x_decimal_indicator():
    # AI 3103 -> 3 implied decimals; payload 001500 -> 1.500 kg
    r = parse_gs1("(3103)001500")
    assert r.net_weight_kg == 1.5


def test_day_00_means_end_of_month():
    # AI 17 = 250600 -> June has 30 days -> 2025-06-30
    r = parse_gs1("(17)250600")
    assert r.expiry_date == "2025-06-30"


def test_all_haccp_dates_mapped():
    r = parse_gs1("(11)250101(13)250102(15)250601(17)250630")
    assert r.production_date == "2025-01-01"
    assert r.packaging_date == "2025-01-02"
    assert r.best_before == "2025-06-01"
    assert r.expiry_date == "2025-06-30"


def test_empty_input_is_empty_result():
    assert parse_gs1(None).is_empty
    assert parse_gs1("   ").is_empty


def test_invalid_gtin_length_is_warned_not_raised():
    r = parse_gs1("(01)3700161210047")  # 13 digits, not 14
    assert r.gtin == "3700161210047"
    assert any("GTIN" in w for w in r.warnings)


def test_invalid_date_is_warned_and_null():
    r = parse_gs1("(17)259999")  # month 99 invalid
    assert r.expiry_date is None
    assert any("17" in w for w in r.warnings)


def test_lot_only():
    r = parse_gs1("(10)2548541")
    assert r.lot == "2548541"
    assert r.gtin is None
    assert r.expiry_date is None
