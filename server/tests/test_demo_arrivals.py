"""The demo catalogue is derived only from facts visible in its label photos."""

import hashlib
import json
from datetime import date
from pathlib import Path

from scripts.seed_demo import ARRIVALS

from labelscan.business_profiles import trade_profile
from labelscan.contexts.ingestion.domain.input_validation import (
    validate_human_field_value,
)

_SERVER_ROOT = Path(__file__).resolve().parents[1]
_MANIFEST_PATH = _SERVER_ROOT / "demo" / "manifest.v2.json"
_IMAGE_DIR = _SERVER_ROOT / "demo" / "images"


def _manifest() -> dict:
    return json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))


def test_every_demo_arrival_displays_every_profile_field_without_fabricated_values() -> (
    None
):
    profile = trade_profile("poissonnerie")
    assert profile.version == "2"
    assert len(profile.fields) == 16
    assert "price" not in profile.fields

    for arrival in ARRIVALS:
        assert set(arrival.fields) == set(profile.fields)
        for field_name, value in arrival.fields.items():
            # Demo seeds are already canonical.  "NC" is a presentation marker,
            # not an extracted fact, and is the sole accepted missing value here.
            assert validate_human_field_value(field_name, value) == value

        packaging_raw = arrival.fields["packaging_date"]
        expiry_raw = arrival.fields["expiry_date"]
        if packaging_raw != "NC" and expiry_raw != "NC":
            assert date.fromisoformat(packaging_raw) <= date.fromisoformat(expiry_raw)


def test_demo_gtins_are_unique() -> None:
    gtins = [
        arrival.fields["gtin"] for arrival in ARRIVALS if arrival.fields["gtin"] != "NC"
    ]
    assert len(gtins) == len(set(gtins))


def test_photo_only_manifest_covers_profile_and_drives_seed_values() -> None:
    manifest = _manifest()
    profile_fields = set(trade_profile("poissonnerie", "2").fields)
    assert manifest["manifest_version"] == "demo-photo-only/v2"
    assert manifest["catalog_missing_value"] == "NC"
    assert len(manifest["images"]) == len(ARRIVALS) == 9

    arrivals = {arrival.key: arrival for arrival in ARRIVALS}
    for image in manifest["images"]:
        fields = image["fields"]
        assert set(fields) == profile_fields

        arrival = arrivals[image["key"]]
        assert arrival.city == image["city"]
        assert arrival.image == image["file"]
        expected = {
            name: (
                item["normalized_value"]
                if item["status"] == "present"
                else manifest["catalog_missing_value"]
            )
            for name, item in fields.items()
        }
        assert arrival.fields == expected
        for item in fields.values():
            assert set(item) >= {
                "raw_value",
                "normalized_value",
                "source",
                "status",
                "evidence",
                "unit",
                "precision",
            }
            assert item["status"] in {"present", "absent", "ambiguous"}
            if item["status"] == "present":
                assert item["raw_value"] and item["normalized_value"]
                assert item["source"] in {"printed_text", "printed_barcode"}
                assert item["precision"]
                assert item["evidence"] and all(
                    part.strip() for part in item["evidence"]
                )
                assert any(item["raw_value"] in part for part in item["evidence"])
            elif item["status"] == "absent":
                assert item["raw_value"] is None
                assert item["normalized_value"] is None
                assert item["evidence"] == []


def test_demo_images_match_manifest_and_contain_no_exif_or_gps_metadata() -> None:
    for image in _manifest()["images"]:
        content = (_IMAGE_DIR / image["file"]).read_bytes()
        assert hashlib.sha256(content).hexdigest() == image["sha256"]
        assert b"Exif\x00\x00" not in content
        assert b"GPSInfo" not in content
        assert b"Apple" not in content
