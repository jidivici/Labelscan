"""Authenticated arrivals feed for administrators and store operators."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import threading
import time
import unicodedata
from datetime import date
from typing import Annotated, Literal, Protocol
from uuid import UUID

import sqlalchemy.exc
from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.business_profiles import (
    COMMON_FIELDS,
    FIELD_CONTRACT_VERSION,
    TRADE_PROFILES,
    field_spec,
)
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
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.db.tenant_context import set_tenant_context
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
_EXPORT_AUDIT: CatalogExportAuditWriter | None = None
_EXPORT_AUDIT_LOCK = threading.Lock()
_MAX_EXPORT_ROWS = 10_000
_EXPORT_PAGE_SIZE = 200


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


class CatalogExportAuditWriter(Protocol):
    def record(
        self,
        *,
        organization_id: str,
        actor_id: str,
        export_format: str,
        row_count: int,
        filter_sha256: str,
        correlation_id: str,
        trace_id: str,
    ) -> None: ...


class SqlCatalogExportAuditWriter:
    """Persist one export event through the narrow database audit function."""

    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def record(
        self,
        *,
        organization_id: str,
        actor_id: str,
        export_format: str,
        row_count: int,
        filter_sha256: str,
        correlation_id: str,
        trace_id: str,
    ) -> None:
        with self._engine.begin() as conn:
            set_tenant_context(conn, organization_id)
            set_audit_context(
                conn,
                actor_id=actor_id,
                action="catalog.exported",
                correlation_id=correlation_id,
                trace_id=trace_id,
            )
            conn.execute(
                text(
                    "SELECT platform.record_catalog_export("
                    ":export_format, :row_count, :filter_sha256)"
                ),
                {
                    "export_format": export_format,
                    "row_count": row_count,
                    "filter_sha256": filter_sha256,
                },
            )


def get_catalog_export_audit() -> CatalogExportAuditWriter:
    global _EXPORT_AUDIT
    if _EXPORT_AUDIT is None:
        with _EXPORT_AUDIT_LOCK:
            if _EXPORT_AUDIT is None:
                from labelscan.platform.db.engine import make_engine

                _EXPORT_AUDIT = SqlCatalogExportAuditWriter(make_engine())
    return _EXPORT_AUDIT


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
    photo_rotation_degrees: int
    photo_base_rotation_degrees: int
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
    photo_base_rotation_degrees: int
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
            photo_rotation_degrees=arrival.photo_rotation_degrees,
            photo_base_rotation_degrees=arrival.photo_base_rotation_degrees,
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
_STORE_CODE = re.compile(r"^[A-Z0-9][A-Z0-9._-]{0,63}$")
_GTIN_LENGTHS = frozenset({8, 12, 13, 14})


def _parse_canonical_uuid(value: object) -> UUID:
    if isinstance(value, UUID):
        return value
    if not isinstance(value, str):
        raise ValueError("UUID filter must be a canonical string")
    try:
        parsed = UUID(value)
    except ValueError as exc:
        raise ValueError("UUID filter is invalid") from exc
    if value != str(parsed):
        raise ValueError("UUID filter must use canonical lowercase form")
    return parsed


CanonicalUUID = Annotated[UUID, BeforeValidator(_parse_canonical_uuid)]


def _contains_unsafe_text(value: str) -> bool:
    return any(
        unicodedata.category(character) in {"Cc", "Cf", "Cs"}
        for character in value
    )


def _safe_query_text(value: str | None, *, label: str, maximum: int) -> str | None:
    if value is None:
        return None
    normalized = unicodedata.normalize("NFC", value)
    if _contains_unsafe_text(normalized):
        raise ValueError(f"{label} contains invalid characters")
    normalized = normalized.strip()
    if not normalized:
        return None
    if len(normalized) > maximum:
        raise ValueError(f"{label} contains invalid characters")
    return normalized


def _safe_store_codes(values: list[str] | None) -> tuple[str, ...]:
    if len(values or ()) > 20:
        raise ValueError("at most 20 store_code values are allowed")
    if any(_contains_unsafe_text(value) for value in (values or ())):
        raise ValueError("store_code contains invalid characters")
    normalized = tuple(
        dict.fromkeys(value.strip().upper() for value in (values or ()))
    )
    if any(not _STORE_CODE.fullmatch(value) for value in normalized):
        raise ValueError("store_code contains invalid characters")
    return normalized


def _safe_gtin(value: str | None) -> str | None:
    normalized = _safe_query_text(value, label="gtin", maximum=14)
    if normalized is None:
        return None
    if not normalized.isascii() or not normalized.isdigit():
        raise ValueError("gtin must contain only ASCII digits")
    if len(normalized) not in _GTIN_LENGTHS:
        raise ValueError("gtin must be a GTIN-8, GTIN-12, GTIN-13 or GTIN-14")
    digits = [int(character) for character in normalized]
    expected = (10 - sum(
        digit * (3 if (len(digits) - index) % 2 == 0 else 1)
        for index, digit in enumerate(digits[:-1])
    ) % 10) % 10
    if digits[-1] != expected:
        raise ValueError("gtin checksum is invalid")
    return normalized


def _parse_field_filters(values: list[str] | None) -> tuple[tuple[str, str], ...]:
    if not values:
        return ()
    if len(values) > 12:
        raise ValueError("at most 12 field_filter values are allowed")
    parsed: list[tuple[str, str]] = []
    for raw in values:
        field_name, separator, field_value = raw.partition(":")
        field_name = (
            _safe_query_text(field_name, label="field_filter", maximum=64) or ""
        )
        field_value = _safe_query_text(field_value, label="field_filter", maximum=120) or ""
        if (
            not separator
            or not _FIELD_NAME.fullmatch(field_name)
            or not field_value
            or len(field_value) > 120
        ):
            raise ValueError("field_filter must use the form field_name:value")
        parsed.append((field_name, field_value))
    return tuple(parsed)


class FieldSpecResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: str
    format: str | None
    max_length: int = Field(gt=0)
    enum: list[str]
    units: list[str]
    nullable: bool


class ProfessionResponse(BaseModel):
    code: str
    name: str
    version: str
    common_fields: list[str]
    specific_fields: list[str]
    required_fields: list[str]
    field_contract_version: str
    field_specs: dict[str, FieldSpecResponse]


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
            field_contract_version=FIELD_CONTRACT_VERSION,
            field_specs={
                name: {
                    "kind": field_spec(name).kind,
                    "format": field_spec(name).format,
                    "max_length": field_spec(name).max_length,
                    "enum": list(field_spec(name).enum),
                    "units": list(field_spec(name).units),
                    "nullable": field_spec(name).nullable,
                }
                for name in profile.fields
            },
        )
        for profile in TRADE_PROFILES.values()
    ]


@router.get("/v1/catalog/products", response_model=CatalogPage, include_in_schema=False)
@router.get("/v1/arrivals", response_model=CatalogPage)
def list_arrivals(
    q: str | None = Query(None, max_length=120),
    store_code: list[str] | None = Query(None),
    business_portal_id: CanonicalUUID | None = Query(None),
    profession: Literal["poissonnerie", "boucherie", "charcuterie_traiteur"]
    | None = Query(None),
    status: Literal["registered", "flagged"] | None = Query(None),
    alert_state: Literal["open", "acknowledged", "resolved"] | None = Query(None),
    completeness_min: int | None = Query(None, ge=0, le=100),
    supplier: str | None = Query(None, max_length=120),
    lot_code: str | None = Query(None, max_length=120),
    gtin: str | None = Query(None, max_length=32),
    captured_by_user_id: CanonicalUUID | None = Query(None),
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
    offset: int = Query(0, ge=0, le=100_000),
    principal: Principal = Depends(require_scope("catalog:read")),
    service: CatalogService = Depends(get_catalog_service),
) -> CatalogPage:
    started_at = time.monotonic()
    try:
        requested_stores = _safe_store_codes(store_code)
        products, total = service.list(
            CatalogQuery(
                access=_catalog_access(principal),
                requested_store_codes=requested_stores,
                query=_safe_query_text(q, label="q", maximum=120),
                date_from=date_from,
                date_to=date_to,
                limit=limit,
                offset=offset,
                requested_business_portal_id=(
                    str(business_portal_id) if business_portal_id else None
                ),
                profession_code=profession,
                status=status,
                alert_state=alert_state,
                completeness_min=completeness_min,
                supplier=_safe_query_text(supplier, label="supplier", maximum=120),
                lot_code=_safe_query_text(lot_code, label="lot_code", maximum=120),
                gtin=_safe_gtin(gtin),
                captured_by_user_id=(
                    str(captured_by_user_id) if captured_by_user_id else None
                ),
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


def _csv_safe(value: object) -> str:
    text_value = "" if value is None else str(value)
    if text_value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + text_value
    return text_value


def _export_row(product: CatalogProduct) -> dict[str, object]:
    return {
        "batch_id": product.batch_id,
        "store_code": product.store_code,
        "product_name": product.product_name,
        "scientific_name": product.scientific_name,
        "gtin": product.gtin,
        "lot_code": product.lot_code,
        "supplier_name": product.supplier_name,
        "status": product.status,
        "fao_area_code": product.fao_area_code,
        "production_method": product.production_method,
        "use_by": product.use_by,
        "packaging_date": product.packaging_date,
        "recorded_at": product.recorded_at,
        "profession_code": product.profession_code,
        "trade_profile_version": product.trade_profile_version,
    }


@router.get("/v1/arrivals/export", response_class=StreamingResponse)
def export_arrivals(
    request: Request,
    export_format: Literal["json", "csv"] = Query("json", alias="format"),
    q: str | None = Query(None, max_length=120),
    store_code: list[str] | None = Query(None),
    business_portal_id: CanonicalUUID | None = Query(None),
    profession: Literal["poissonnerie", "boucherie", "charcuterie_traiteur"]
    | None = Query(None),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    principal: Principal = Depends(require_scope("export:read")),
    service: CatalogService = Depends(get_catalog_service),
    audit: CatalogExportAuditWriter = Depends(get_catalog_export_audit),
) -> StreamingResponse:
    try:
        requested_stores = _safe_store_codes(store_code)
        safe_query = _safe_query_text(q, label="q", maximum=120)
    except ValueError as exc:
        raise ApiError("VALIDATION_ERROR", str(exc))
    access = _catalog_access(principal)
    portal_id = str(business_portal_id) if business_portal_id else None

    def page(offset: int) -> tuple[list[CatalogProduct], int]:
        return service.list(
            CatalogQuery(
                access=access,
                requested_store_codes=requested_stores,
                requested_business_portal_id=portal_id,
                profession_code=profession,
                query=safe_query,
                date_from=date_from,
                date_to=date_to,
                limit=_EXPORT_PAGE_SIZE,
                offset=offset,
                include_total=offset == 0,
            )
        )

    try:
        products, total = page(0)
    except CatalogAccessDenied:
        raise ApiError("FORBIDDEN", "arrivals access is limited to your store")
    except CatalogStoreRequired:
        raise ApiError("STORE_REQUIRED", "your account has no store assignment")
    except ValueError as exc:
        raise ApiError("VALIDATION_ERROR", str(exc))
    if total > _MAX_EXPORT_ROWS:
        raise ApiError(
            "EXPORT_TOO_LARGE",
            f"export contains {total} rows; narrow the filters below {_MAX_EXPORT_ROWS + 1}",
        )
    offset = len(products)
    while offset < total:
        next_products, _ = page(offset)
        if not next_products:
            break
        products.extend(next_products)
        offset += len(next_products)

    rows = [_export_row(product) for product in products]
    filter_document = json.dumps(
        {
            "business_portal_id": portal_id,
            "date_from": date_from.isoformat() if date_from else None,
            "date_to": date_to.isoformat() if date_to else None,
            "profession": profession,
            "q": safe_query,
            "store_codes": list(requested_stores),
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    filter_sha256 = hashlib.sha256(filter_document.encode("utf-8")).hexdigest()
    try:
        audit.record(
            organization_id=access.organization_id,
            actor_id=principal.actor_id,
            export_format=export_format,
            row_count=len(rows),
            filter_sha256=filter_sha256,
            correlation_id=request.state.correlation_id,
            trace_id=request.state.trace_id,
        )
    except (sqlalchemy.exc.SQLAlchemyError, OSError) as exc:
        raise ApiError(
            "DEPENDENCY_UNAVAILABLE",
            "export audit storage is unavailable",
        ) from exc
    _log.info(
        "catalog_export",
        extra={
            "actor_id": principal.actor_id,
            "organization_id": access.organization_id,
            "export_format": export_format,
            "row_count": len(rows),
            "correlation_id": request.state.correlation_id,
        },
    )
    headers = {
        "Content-Disposition": f'attachment; filename="labelscan-arrivals.{export_format}"',
        "X-Export-Row-Count": str(len(rows)),
    }
    if export_format == "json":
        payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
        return StreamingResponse(iter([payload]), media_type="application/json", headers=headers)

    output = io.StringIO(newline="")
    fieldnames = list(_export_row(products[0]).keys()) if products else [
        "batch_id", "store_code", "product_name", "scientific_name", "gtin",
        "lot_code", "supplier_name", "status", "fao_area_code", "production_method",
        "use_by", "packaging_date", "recorded_at", "profession_code",
        "trade_profile_version",
    ]
    writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({key: _csv_safe(value) for key, value in row.items()})
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers=headers)


@router.get("/v1/arrivals/{batch_id}", response_model=CatalogArrivalResponse)
def get_arrival(
    batch_id: CanonicalUUID,
    principal: Principal = Depends(require_scope("catalog:read")),
    service: CatalogService = Depends(get_catalog_service),
) -> CatalogArrivalResponse:
    try:
        arrival = service.arrival(
            CatalogArrivalQuery(
                access=_catalog_access(principal),
                batch_id=str(batch_id),
            )
        )
    except CatalogStoreRequired:
        raise ApiError("STORE_REQUIRED", "your account has no store assignment")
    except CatalogArrivalNotFound:
        raise ApiError("NOT_FOUND", "arrival not found")
    return CatalogArrivalResponse.from_domain(arrival)


@router.get("/v1/arrivals/{batch_id}/image", response_class=Response)
def get_arrival_image(
    batch_id: CanonicalUUID,
    principal: Principal = Depends(require_scope("catalog:read")),
    service: CatalogService = Depends(get_catalog_service),
    reader=Depends(get_raw_image_reader),
) -> Response:
    try:
        checksum = service.image_checksum(
            CatalogImageQuery(
                access=_catalog_access(principal),
                batch_id=str(batch_id),
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
        # Arrival images are immutable for a batch.  Keep them in the browser's
        # private cache so changing pages or reloading the catalogue does not
        # download every thumbnail again.  Vary by both auth mechanisms to
        # prevent a cached image from being reused for another signed-in user.
        headers={
            "Cache-Control": "private, max-age=86400, immutable",
            "ETag": f'"{checksum}"',
            "Vary": "Authorization, Cookie",
        },
    )
