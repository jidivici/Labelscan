"""Authenticated arrivals feed for administrators and store operators."""

from __future__ import annotations

import re
import threading
import time
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, Path, Query, Response
from pydantic import BaseModel

from labelscan.business_profiles import COMMON_FIELDS, TRADE_PROFILES
from labelscan.contexts.traceability.application.catalog import (
    CatalogAccess,
    CatalogAccessDenied,
    CatalogArrivalNotFound,
    CatalogArrivalQuery,
    CatalogImageQuery,
    CatalogQuery,
    CatalogService,
    CatalogStoreRequired,
)
from labelscan.contexts.traceability.domain.catalog import (
    CatalogArrival,
    CatalogProduct,
)
from labelscan.platform.http.access import access_context_for_principal
from labelscan.platform.http.errors import ApiError
from labelscan.platform.http.security import Principal, require_scope
from labelscan.platform.observability import get_logger
from labelscan.platform.raw_images import RawImageNotFound

router = APIRouter()
_log = get_logger("catalog")

_SERVICE: CatalogService | None = None
_SERVICE_LOCK = threading.Lock()
_IMAGE_READER = None
_IMAGE_READER_LOCK = threading.Lock()
_DEFAULT_ORGANIZATION_ID: str | None = None
_DEFAULT_ORGANIZATION_LOCK = threading.Lock()


def get_catalog_service() -> CatalogService:
    global _SERVICE
    if _SERVICE is None:
        with _SERVICE_LOCK:
            if _SERVICE is None:
                from labelscan.contexts.traceability.adapters import (
                    sql_catalog_repository,
                )
                from labelscan.platform.db.engine import make_engine

                _SERVICE = CatalogService(
                    sql_catalog_repository.SqlCatalogRepository(make_engine())
                )
    return _SERVICE


def get_raw_image_reader():
    global _IMAGE_READER
    if _IMAGE_READER is None:
        with _IMAGE_READER_LOCK:
            if _IMAGE_READER is None:
                from labelscan.platform.storage_factory import build_raw_image_reader

                _IMAGE_READER = build_raw_image_reader()
    return _IMAGE_READER


def _default_organization_id() -> str:
    global _DEFAULT_ORGANIZATION_ID
    if _DEFAULT_ORGANIZATION_ID is None:
        with _DEFAULT_ORGANIZATION_LOCK:
            if _DEFAULT_ORGANIZATION_ID is None:
                from sqlalchemy import text

                from labelscan.platform.db.engine import make_engine

                with make_engine().connect() as conn:
                    _DEFAULT_ORGANIZATION_ID = str(
                        conn.execute(
                            text(
                                "SELECT id FROM identity.organization "
                                "WHERE slug = 'labelscan'"
                            )
                        ).scalar_one()
                    )
    return _DEFAULT_ORGANIZATION_ID


class CatalogProductResponse(BaseModel):
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
    photo_available: bool
    store_id: str | None
    business_portal_id: str | None
    profession_code: str
    trade_profile_version: str
    captured_by_user_id: str | None
    completeness: int
    alert_state: str | None
    alert_severity: str | None

    @classmethod
    def from_domain(cls, product: CatalogProduct) -> "CatalogProductResponse":
        return cls(**product.__dict__)


class CatalogPage(BaseModel):
    items: list[CatalogProductResponse]
    total: int
    limit: int
    offset: int


class CatalogArrivalResponse(BaseModel):
    batch_id: str
    ingestion_id: str
    store_code: str | None
    status: str
    fields: dict[str, str | None]
    validation: dict[str, dict[str, object]]
    revision_no: int
    recorded_at: str
    updated_at: str
    photo_available: bool
    photo_rotation_degrees: int
    store_id: str | None
    business_portal_id: str | None
    profession_code: str
    trade_profile_version: str
    captured_by_user_id: str | None
    captured_by_user_name: str | None
    completeness: int
    alert_state: str | None
    alert_severity: str | None

    @classmethod
    def from_domain(cls, arrival: CatalogArrival) -> "CatalogArrivalResponse":
        return cls(
            batch_id=arrival.batch_id,
            ingestion_id=arrival.ingestion_id,
            store_code=arrival.store_code,
            status=arrival.status,
            fields=arrival.fields,
            validation=arrival.validation,
            revision_no=arrival.revision_no,
            recorded_at=arrival.recorded_at,
            updated_at=arrival.updated_at,
            photo_available=arrival.photo_available,
            store_id=arrival.store_id,
            business_portal_id=arrival.business_portal_id,
            profession_code=arrival.profession_code,
            trade_profile_version=arrival.trade_profile_version,
            captured_by_user_id=arrival.captured_by_user_id,
            captured_by_user_name=arrival.captured_by_user_name,
            completeness=arrival.completeness,
            alert_state=arrival.alert_state,
            alert_severity=arrival.alert_severity,
        )


def _catalog_access(principal: Principal) -> CatalogAccess:
    organization_id = principal.organization_id or _default_organization_id()
    return CatalogAccess(
        organization_id=organization_id,
        store_code=principal.store_code,
        can_view_all_stores=principal.role == "super_admin",
        context=access_context_for_principal(
            principal, default_organization_id=organization_id
        ),
    )


_FIELD_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


def _parse_field_filters(values: list[str] | None) -> tuple[tuple[str, str], ...]:
    if not values:
        return ()
    if len(values) > 12:
        raise ValueError("at most 12 field_filter values are allowed")
    parsed: list[tuple[str, str]] = []
    for raw in values:
        field_name, separator, field_value = raw.partition(":")
        field_name = field_name.strip()
        field_value = field_value.strip()
        if (
            not separator
            or not _FIELD_NAME.fullmatch(field_name)
            or not field_value
            or len(field_value) > 120
        ):
            raise ValueError("field_filter must use the form field_name:value")
        parsed.append((field_name, field_value))
    return tuple(parsed)


class ProfessionResponse(BaseModel):
    code: str
    name: str
    version: str
    common_fields: list[str]
    specific_fields: list[str]
    required_fields: list[str]


@router.get("/v1/professions", response_model=list[ProfessionResponse])
def list_professions(
    principal: Principal = Depends(require_scope("catalog:read")),
) -> list[ProfessionResponse]:
    del principal
    return [
        ProfessionResponse(
            code=profile.code,
            name=profile.display_name,
            version=profile.version,
            common_fields=list(COMMON_FIELDS),
            specific_fields=list(profile.specific_fields),
            required_fields=list(profile.required_fields),
        )
        for profile in TRADE_PROFILES.values()
    ]


@router.get("/v1/catalog/products", response_model=CatalogPage, include_in_schema=False)
@router.get("/v1/arrivals", response_model=CatalogPage)
def list_arrivals(
    q: str | None = Query(None, max_length=120),
    store_code: list[str] | None = Query(None),
    business_portal_id: str | None = Query(None, max_length=64),
    profession: Literal["poissonnerie", "boucherie", "charcuterie_traiteur"]
    | None = Query(None),
    status: Literal["registered", "flagged"] | None = Query(None),
    alert_state: Literal["open", "acknowledged", "resolved"] | None = Query(None),
    completeness_min: int | None = Query(None, ge=0, le=100),
    supplier: str | None = Query(None, max_length=120),
    lot_code: str | None = Query(None, max_length=120),
    gtin: str | None = Query(None, max_length=32),
    captured_by_user_id: str | None = Query(None, max_length=64),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    expiry_from: date | None = Query(None),
    expiry_to: date | None = Query(None),
    field_filter: list[str] | None = Query(None),
    sort_by: Literal[
        "recorded_at",
        "expiry_date",
        "product_name",
        "supplier",
        "lot_code",
        "completeness",
        "status",
    ] = Query("recorded_at"),
    sort_direction: Literal["asc", "desc"] = Query("desc"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    principal: Principal = Depends(require_scope("catalog:read")),
    service: CatalogService = Depends(get_catalog_service),
) -> CatalogPage:
    started_at = time.monotonic()
    try:
        requested_stores = tuple(store_code or ())
        products, total = service.list(
            CatalogQuery(
                access=_catalog_access(principal),
                requested_store_codes=requested_stores,
                query=q,
                date_from=date_from,
                date_to=date_to,
                limit=limit,
                offset=offset,
                requested_business_portal_id=business_portal_id,
                profession_code=profession,
                status=status,
                alert_state=alert_state,
                completeness_min=completeness_min,
                supplier=supplier,
                lot_code=lot_code,
                gtin=gtin,
                captured_by_user_id=captured_by_user_id,
                expiry_from=expiry_from,
                expiry_to=expiry_to,
                field_filters=_parse_field_filters(field_filter),
                sort_by=sort_by,
                sort_direction=sort_direction,
            )
        )
    except CatalogAccessDenied:
        raise ApiError("FORBIDDEN", "arrivals access is limited to your store")
    except CatalogStoreRequired:
        raise ApiError("STORE_REQUIRED", "your account has no store assignment")
    except ValueError as exc:
        raise ApiError("VALIDATION_ERROR", str(exc))

    _log.info(
        "catalog_query",
        extra={
            "organization_id": _catalog_access(principal).organization_id,
            "latency_ms": round((time.monotonic() - started_at) * 1000, 1),
            "total": total,
        },
    )
    return CatalogPage(
        items=[CatalogProductResponse.from_domain(product) for product in products],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/v1/arrivals/{batch_id}", response_model=CatalogArrivalResponse)
def get_arrival(
    batch_id: str = Path(min_length=1, max_length=128),
    principal: Principal = Depends(require_scope("catalog:read")),
    service: CatalogService = Depends(get_catalog_service),
) -> CatalogArrivalResponse:
    try:
        arrival = service.arrival(
            CatalogArrivalQuery(
                access=_catalog_access(principal),
                batch_id=batch_id,
            )
        )
    except CatalogStoreRequired:
        raise ApiError("STORE_REQUIRED", "your account has no store assignment")
    except CatalogArrivalNotFound:
        raise ApiError("NOT_FOUND", "arrival not found")
    return CatalogArrivalResponse.from_domain(arrival)


@router.get("/v1/arrivals/{batch_id}/image", response_class=Response)
def get_arrival_image(
    batch_id: str = Path(min_length=1, max_length=128),
    principal: Principal = Depends(require_scope("catalog:read")),
    service: CatalogService = Depends(get_catalog_service),
    reader=Depends(get_raw_image_reader),
) -> Response:
    try:
        checksum = service.image_checksum(
            CatalogImageQuery(
                access=_catalog_access(principal),
                batch_id=batch_id,
            )
        )
    except CatalogStoreRequired:
        raise ApiError("STORE_REQUIRED", "your account has no store assignment")
    except CatalogArrivalNotFound:
        raise ApiError("NOT_FOUND", "arrival image not found")

    try:
        try:
            image = reader.read(checksum, principal.organization_id)
        except TypeError:
            # Temporary compatibility for file readers/test doubles that predate
            # tenant-aware object keys. Production adapters accept organization_id.
            image = reader.read(checksum)
    except RawImageNotFound:
        raise ApiError("NOT_FOUND", "arrival image not found")
    return Response(
        content=image.content,
        media_type=image.media_type,
        headers={"Cache-Control": "no-store"},
    )
