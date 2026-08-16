"""Store catalogue read model owned by the traceability context."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CatalogProduct:
    """One registered product occurrence, represented by its immutable batch."""

    batch_id: str
    store_code: str | None
    product_name: str | None
    scientific_name: str | None
    gtin: str | None
    lot_code: str
    supplier_name: str | None
    status: str
    fao_area_code: str | None
    production_method: str | None
    use_by: str | None
    packaging_date: str | None
    recorded_at: str
    photo_available: bool = True
    photo_rotation_degrees: int = 0
    photo_base_rotation_degrees: int = -90
    store_id: str | None = None
    business_portal_id: str | None = None
    profession_code: str = "poissonnerie"
    trade_profile_version: str = "1"
    captured_by_user_id: str | None = None
    completeness: int = 0
    alert_state: str | None = None
    alert_severity: str | None = None


@dataclass(frozen=True)
class CatalogArrival:
    """Complete vertical arrival sheet backed by the latest projection."""

    batch_id: str
    ingestion_id: str
    organization_id: str
    store_code: str | None
    status: str
    fields: dict[str, str | None]
    validation: dict[str, dict[str, object]]
    revision_no: int
    recorded_at: str
    updated_at: str
    photo_available: bool
    photo_rotation_degrees: int = 0
    photo_base_rotation_degrees: int = -90
    store_id: str | None = None
    business_portal_id: str | None = None
    profession_code: str = "poissonnerie"
    trade_profile_version: str = "1"
    captured_by_user_id: str | None = None
    captured_by_user_name: str | None = None
    completeness: int = 0
    alert_state: str | None = None
    alert_severity: str | None = None
