"""Versioned extraction contracts for the supported food-trade portals."""

from __future__ import annotations

from dataclasses import dataclass

FIELD_CONTRACT_VERSION = "1"

COMMON_FIELDS_V1 = (
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

COMMON_FIELDS = tuple(field for field in COMMON_FIELDS_V1 if field != "price")


@dataclass(frozen=True)
class TradeProfile:
    code: str
    display_name: str
    version: str
    common_fields: tuple[str, ...]
    specific_fields: tuple[str, ...]
    required_fields: tuple[str, ...]

    @property
    def fields(self) -> tuple[str, ...]:
        return self.common_fields + self.specific_fields


@dataclass(frozen=True)
class FieldSpec:
    kind: str = "text"
    format: str | None = None
    max_length: int = 512
    enum: tuple[str, ...] = ()
    units: tuple[str, ...] = ()
    nullable: bool = True


_DEFAULT_FIELD_SPEC = FieldSpec()
FIELD_SPECS: dict[str, FieldSpec] = {
    "expiry_date": FieldSpec(kind="date", format="YYYY-MM-DD", max_length=10),
    "packaging_date": FieldSpec(kind="date", format="YYYY-MM-DD", max_length=10),
    "preparation_date": FieldSpec(kind="date", format="YYYY-MM-DD", max_length=10),
    "weight": FieldSpec(
        kind="decimal_unit", format="decimal unit", max_length=32, units=("g", "kg")
    ),
    "storage_temperature": FieldSpec(
        kind="temperature_range", format="celsius", max_length=40, units=("°C",)
    ),
    "production_method": FieldSpec(
        kind="enum", max_length=32, enum=("wild_caught", "farmed")
    ),
    "gtin": FieldSpec(kind="gtin", format="GTIN-8/12/13/14", max_length=14),
    "health_mark": FieldSpec(kind="health_mark", max_length=64),
    "FAO_area": FieldSpec(kind="fao_area", max_length=120),
    "origin_country": FieldSpec(kind="country", max_length=80),
    "birth_country": FieldSpec(kind="country", max_length=80),
    "rearing_country": FieldSpec(kind="country", max_length=80),
    "slaughter_country": FieldSpec(kind="country", max_length=80),
    "cutting_country": FieldSpec(kind="country", max_length=80),
}


def field_spec(name: str) -> FieldSpec:
    return FIELD_SPECS.get(name, _DEFAULT_FIELD_SPEC)


def _profiles(version: str, common_fields: tuple[str, ...]) -> dict[str, TradeProfile]:
    return {
        "poissonnerie": TradeProfile(
            code="poissonnerie",
            display_name="Poissonnerie",
            version=version,
            common_fields=common_fields,
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
            version=version,
            common_fields=common_fields,
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
            version=version,
            common_fields=common_fields,
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


# V2 is the active production contract. V1 remains resolvable for immutable historical
# ingestions and append-only catalogue rows created before the price field was retired.
TRADE_PROFILES: dict[str, TradeProfile] = _profiles("2", COMMON_FIELDS)
LEGACY_TRADE_PROFILES: dict[tuple[str, str], TradeProfile] = {
    (code, "1"): TradeProfile(
        code=profile.code,
        display_name=profile.display_name,
        version="1",
        common_fields=profile.common_fields,
        specific_fields=profile.specific_fields,
        required_fields=profile.required_fields,
    )
    for code, profile in _profiles("1", COMMON_FIELDS_V1).items()
}


def trade_profile(code: str | None, version: str | None = None) -> TradeProfile:
    normalized = (code or "poissonnerie").strip().lower()
    try:
        current = TRADE_PROFILES[normalized]
    except KeyError as exc:
        raise ValueError(f"unknown profession '{normalized}'") from exc
    if version is None or version == current.version:
        return current
    legacy = LEGACY_TRADE_PROFILES.get((normalized, version))
    if legacy is not None:
        return legacy
    raise ValueError(
        f"unsupported profile version '{version}' for profession '{normalized}'"
    )
