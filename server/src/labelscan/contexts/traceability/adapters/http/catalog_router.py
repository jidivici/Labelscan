"""Authenticated arrivals feed for administrators and store operators."""

from __future__ import annotations

import threading
import time
from datetime import date

from fastapi import APIRouter, Depends, Path, Query, Response
from pydantic import BaseModel

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
        )


def _catalog_access(principal: Principal) -> CatalogAccess:
    return CatalogAccess(
        organization_id=principal.organization_id or _default_organization_id(),
        store_code=principal.store_code,
        can_view_all_stores=principal.role == "admin",
    )


@router.get("/v1/catalog/products", response_model=CatalogPage, include_in_schema=False)
@router.get("/v1/arrivals", response_model=CatalogPage)
def list_arrivals(
    q: str | None = Query(None, max_length=120),
    store_code: str | None = Query(None, max_length=64),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    principal: Principal = Depends(require_scope("catalog:read")),
    service: CatalogService = Depends(get_catalog_service),
) -> CatalogPage:
    started_at = time.monotonic()
    try:
        products, total = service.list(
            CatalogQuery(
                access=_catalog_access(principal),
                requested_store_code=store_code,
                query=q,
                date_from=date_from,
                date_to=date_to,
                limit=limit,
                offset=offset,
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
