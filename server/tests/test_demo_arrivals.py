"""The production demo catalogue mirrors the active 16-field poissonnerie profile."""

from datetime import date

from labelscan.business_profiles import trade_profile
from labelscan.contexts.ingestion.domain.input_validation import validate_human_field_value
from scripts.seed_demo import ARRIVALS


def test_every_demo_arrival_is_complete_and_valid_for_profile_v2() -> None:
    profile = trade_profile("poissonnerie")
    assert profile.version == "2"
    assert len(profile.fields) == 16
    assert "price" not in profile.fields

    for arrival in ARRIVALS:
        assert set(arrival.fields) == set(profile.fields)
        for field_name, value in arrival.fields.items():
            assert validate_human_field_value(field_name, value) is not None

        packaging = date.fromisoformat(arrival.fields["packaging_date"])
        expiry = date.fromisoformat(arrival.fields["expiry_date"])
        assert packaging <= expiry


def test_demo_gtins_are_unique() -> None:
    gtins = [arrival.fields["gtin"] for arrival in ARRIVALS]
    assert len(gtins) == len(set(gtins))
