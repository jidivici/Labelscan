"""Versioned extraction contracts for the supported food-trade portals."""

from __future__ import annotations

from dataclasses import dataclass

COMMON_FIELDS = (
    "commercial_designation",
    "producer_name",
    "reseller_brand",
    "batch_number",
    "origin_country",
    "expiry_date",
    "packaging_date",
    "storage_temperature",
    "allergens",
    "health_mark",
    "weight",
    "price",
    "gtin",
)


@dataclass(frozen=True)
class TradeProfile:
    code: str
    display_name: str
    version: str
    specific_fields: tuple[str, ...]
    required_fields: tuple[str, ...]

    @property
    def fields(self) -> tuple[str, ...]:
        return COMMON_FIELDS + self.specific_fields


TRADE_PROFILES: dict[str, TradeProfile] = {
    "poissonnerie": TradeProfile(
        code="poissonnerie",
        display_name="Poissonnerie",
        version="1",
        specific_fields=(
            "scientific_name",
            "FAO_area",
            "production_method",
            "fishing_gear_or_farming_method",
        ),
        required_fields=("scientific_name", "expiry_date", "production_method"),
    ),
    "boucherie": TradeProfile(
        code="boucherie",
        display_name="Boucherie",
        version="1",
        specific_fields=(
            "animal_species",
            "animal_category",
            "cut_name",
            "birth_country",
            "rearing_country",
            "slaughter_country",
            "cutting_country",
            "slaughterhouse_approval",
            "cutting_plant_approval",
        ),
        required_fields=("animal_species", "cut_name", "expiry_date"),
    ),
    "charcuterie_traiteur": TradeProfile(
        code="charcuterie_traiteur",
        display_name="Charcuterie / Traiteur",
        version="1",
        specific_fields=(
            "product_family",
            "manufacturer_name",
            "ingredients",
            "additives",
            "preparation_date",
            "conditioning_type",
            "storage_mode",
            "use_instructions",
            "reheating_instructions",
        ),
        required_fields=("commercial_designation", "expiry_date", "ingredients"),
    ),
}


def trade_profile(code: str | None, version: str | None = None) -> TradeProfile:
    normalized = (code or "poissonnerie").strip().lower()
    try:
        profile = TRADE_PROFILES[normalized]
    except KeyError as exc:
        raise ValueError(f"unknown profession '{normalized}'") from exc
    if version is not None and version != profile.version:
        raise ValueError(
            f"unsupported profile version '{version}' for profession '{normalized}'"
        )
    return profile
