"""Tenant-scoped PostgreSQL catalogue projection adapter."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.business_profiles import TRADE_PROFILES
from labelscan.contexts.traceability.application.catalog_ports import (
    CatalogFilter,
    CatalogRepository,
)
from labelscan.contexts.traceability.domain.catalog import (
    CatalogArrival,
    CatalogProduct,
)
from labelscan.platform.db.tenant_context import set_tenant_context
from labelscan.platform.http.access import AccessContext, postgres_scope

_PROFILE_SIZE_SQL = "\n".join(
    f"        WHEN '{code}' THEN {len(profile.fields)}"
    for code, profile in TRADE_PROFILES.items()
)

_COMPLETENESS_SQL = f"""
LEAST(100, ROUND(
    100.0 * (
        SELECT count(*)
        FROM jsonb_each(projection.fields) AS field
        WHERE field.value <> 'null'::jsonb
          AND field.value <> '\"\"'::jsonb
    ) /
    CASE projection.trade_code_snapshot
{_PROFILE_SIZE_SQL}
        ELSE {len(TRADE_PROFILES["poissonnerie"].fields)}
    END
))::integer
""".strip()

_ALERT_STATE_SQL = """
(
    SELECT alert.state
    FROM haccp.alert AS alert
    WHERE alert.organization_id = projection.organization_id
      AND alert.batch_id = projection.batch_id
      AND alert.business_portal_id IS NOT DISTINCT FROM projection.business_portal_id
    ORDER BY CASE alert.state
        WHEN 'open' THEN 1 WHEN 'acknowledged' THEN 2 ELSE 3 END,
        alert.created_at DESC
    LIMIT 1
)
""".strip()

_ALERT_SEVERITY_SQL = """
(
    SELECT alert.severity
    FROM haccp.alert AS alert
    WHERE alert.organization_id = projection.organization_id
      AND alert.batch_id = projection.batch_id
      AND alert.business_portal_id IS NOT DISTINCT FROM projection.business_portal_id
    ORDER BY CASE alert.severity
        WHEN 'critical' THEN 1 WHEN 'high' THEN 2
        WHEN 'medium' THEN 3 ELSE 4 END,
        alert.created_at DESC
    LIMIT 1
)
""".strip()


def _text_value(fields: dict, name: str) -> str | None:
    value = fields.get(name)
    return str(value) if value is not None else None


def _product(row) -> CatalogProduct:
    fields = row["fields"] or {}
    return CatalogProduct(
        batch_id=row["batch_id"],
        store_code=row["store_code"],
        product_name=_text_value(fields, "commercial_designation")
        or _text_value(fields, "product_name"),
        scientific_name=_text_value(fields, "scientific_name"),
        gtin=_text_value(fields, "gtin"),
        lot_code=_text_value(fields, "batch_number") or "",
        supplier_name=_text_value(fields, "reseller_brand")
        or _text_value(fields, "producer_name")
        or _text_value(fields, "supplier_name"),
        status=row["status"],
        fao_area_code=_text_value(fields, "FAO_area"),
        production_method=_text_value(fields, "production_method"),
        use_by=_text_value(fields, "expiry_date"),
        packaging_date=_text_value(fields, "packaging_date"),
        recorded_at=row["recorded_at"],
        photo_available=bool(row["image_checksum"]),
        photo_rotation_degrees=int(row["photo_rotation_degrees"]),
        store_id=row["store_id"],
        business_portal_id=row["business_portal_id"],
        profession_code=row["profession_code"],
        trade_profile_version=row["trade_profile_version"],
        captured_by_user_id=row["captured_by_user_id"],
        completeness=int(row["completeness"]),
        alert_state=row["alert_state"],
        alert_severity=row["alert_severity"],
    )


class SqlCatalogRepository(CatalogRepository):
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def list_products(self, filters: CatalogFilter) -> tuple[list[CatalogProduct], int]:
        if filters.access is None:
            conditions = ["projection.organization_id::text = :organization_id"]
            scope_params: dict[str, object] = {}
        else:
            scope, scope_params = postgres_scope(filters.access, alias="projection")
            conditions = [scope]
        params: dict[str, object] = {
            "organization_id": filters.organization_id,
            "limit": filters.limit,
            "offset": filters.offset,
            **scope_params,
        }
        store_codes = filters.store_codes or (
            (filters.store_code,) if filters.store_code is not None else ()
        )
        if store_codes:
            conditions.append(
                "projection.store_code = ANY(CAST(:store_codes AS text[]))"
            )
            params["store_codes"] = list(store_codes)
        if filters.business_portal_id is not None:
            conditions.append(
                "projection.business_portal_id::text = :business_portal_id"
            )
            params["business_portal_id"] = filters.business_portal_id
        if filters.profession_code is not None:
            conditions.append("projection.trade_code_snapshot = :profession_code")
            params["profession_code"] = filters.profession_code
        if filters.status is not None:
            conditions.append("batch.status = :status")
            params["status"] = filters.status
        if filters.alert_state is not None:
            conditions.append(f"{_ALERT_STATE_SQL} = :alert_state")
            params["alert_state"] = filters.alert_state
        if filters.completeness_min is not None:
            conditions.append(f"{_COMPLETENESS_SQL} >= :completeness_min")
            params["completeness_min"] = filters.completeness_min
        if filters.query is not None:
            conditions.append(
                "("
                "projection.fields::text ILIKE :query AND ("
                "COALESCE(projection.fields->>'commercial_designation', '') "
                "ILIKE :query "
                "OR COALESCE(projection.fields->>'scientific_name', '') ILIKE :query "
                "OR COALESCE(projection.fields->>'gtin', '') ILIKE :query "
                "OR COALESCE(projection.fields->>'batch_number', '') ILIKE :query "
                "OR COALESCE(projection.fields->>'reseller_brand', '') ILIKE :query "
                "OR COALESCE(projection.fields->>'producer_name', '') ILIKE :query "
                "OR COALESCE(projection.fields->>'supplier_name', '') ILIKE :query"
                ")"
                ")"
            )
            params["query"] = f"%{filters.query}%"
        if filters.supplier is not None:
            conditions.append(
                "COALESCE(projection.fields->>'reseller_brand', "
                "projection.fields->>'producer_name', "
                "projection.fields->>'supplier_name', '') ILIKE :supplier"
            )
            params["supplier"] = f"%{filters.supplier}%"
        if filters.lot_code is not None:
            conditions.append(
                "COALESCE(projection.fields->>'batch_number', '') ILIKE :lot_code"
            )
            params["lot_code"] = f"%{filters.lot_code}%"
        if filters.gtin is not None:
            conditions.append("projection.fields->>'gtin' = :gtin")
            params["gtin"] = filters.gtin
        if filters.captured_by_user_id is not None:
            conditions.append(
                "projection.captured_by_user_id::text = :captured_by_user_id"
            )
            params["captured_by_user_id"] = filters.captured_by_user_id
        if filters.date_from is not None:
            conditions.append("projection.recorded_at >= CAST(:date_from AS date)")
            params["date_from"] = filters.date_from
        if filters.date_to is not None:
            conditions.append(
                "projection.recorded_at < CAST(:date_to AS date) + interval '1 day'"
            )
            params["date_to"] = filters.date_to
        if filters.expiry_from is not None:
            conditions.append("projection.fields->>'expiry_date' >= :expiry_from")
            params["expiry_from"] = filters.expiry_from.isoformat()
        if filters.expiry_to is not None:
            conditions.append("projection.fields->>'expiry_date' <= :expiry_to")
            params["expiry_to"] = filters.expiry_to.isoformat()
        for index, (field_name, field_value) in enumerate(filters.field_filters):
            name_param = f"field_name_{index}"
            value_param = f"field_value_{index}"
            conditions.append(
                "(projection.fields::text ILIKE :"
                f"{value_param} AND COALESCE(jsonb_extract_path_text("
                "projection.fields, "
                f":{name_param}), '') ILIKE :{value_param})"
            )
            params[name_param] = field_name
            params[value_param] = f"%{field_value}%"
        where = f"WHERE {' AND '.join(conditions)}"
        base = (
            "FROM traceability.arrival_projection AS projection "
            "JOIN traceability.batch AS batch ON batch.id = projection.batch_id "
            "JOIN ingestion.ingestion AS ingestion ON ingestion.id = projection.ingestion_id "
            f"{where}"
        )
        columns = (
            "projection.batch_id::text AS batch_id, projection.store_code, "
            "projection.store_id::text AS store_id, "
            "projection.business_portal_id::text AS business_portal_id, "
            "projection.trade_code_snapshot AS profession_code, "
            "projection.trade_profile_version, "
            "projection.captured_by_user_id::text AS captured_by_user_id, "
            "projection.fields, projection.image_checksum, batch.status, "
            "ingestion.photo_rotation_degrees, "
            "projection.recorded_at::text AS recorded_at, "
            f"{_COMPLETENESS_SQL} AS completeness, "
            f"{_ALERT_STATE_SQL} AS alert_state, "
            f"{_ALERT_SEVERITY_SQL} AS alert_severity"
        )
        sort_columns = {
            "recorded_at": "projection.recorded_at",
            "expiry_date": "projection.fields->>'expiry_date'",
            "product_name": (
                "COALESCE(projection.fields->>'commercial_designation', "
                "projection.fields->>'product_name', '')"
            ),
            "supplier": (
                "COALESCE(projection.fields->>'reseller_brand', "
                "projection.fields->>'producer_name', "
                "projection.fields->>'supplier_name', '')"
            ),
            "lot_code": "projection.fields->>'batch_number'",
            "completeness": _COMPLETENESS_SQL,
            "status": "batch.status",
        }
        sort_column = sort_columns[filters.sort_by]
        sort_direction = filters.sort_direction.upper()
        with self._engine.connect() as conn:
            set_tenant_context(conn, filters.organization_id)
            total = int(
                conn.execute(text(f"SELECT count(*) {base}"), params).scalar_one()
            )
            rows = (
                conn.execute(
                    text(
                        f"SELECT {columns} {base} "
                        f"ORDER BY {sort_column} {sort_direction} NULLS LAST, "
                        "projection.batch_id "
                        "LIMIT :limit OFFSET :offset"
                    ),
                    params,
                )
                .mappings()
                .all()
            )
        return [_product(row) for row in rows], total

    def get_arrival(
        self,
        organization_id: str,
        batch_id: str,
        store_code: str | None,
        access: AccessContext | None = None,
    ) -> CatalogArrival | None:
        if access is None:
            conditions = ["projection.organization_id::text = :organization_id"]
            scope_params: dict[str, object] = {}
        else:
            scope, scope_params = postgres_scope(access, alias="projection")
            conditions = [scope]
        conditions.append("projection.batch_id::text = :batch_id")
        params: dict[str, object] = {
            "organization_id": organization_id,
            "batch_id": batch_id,
            **scope_params,
        }
        if store_code is not None:
            conditions.append("projection.store_code = :store_code")
            params["store_code"] = store_code
        with self._engine.connect() as conn:
            set_tenant_context(conn, organization_id)
            row = (
                conn.execute(
                    text(
                        "SELECT projection.batch_id::text AS batch_id, "
                        "projection.ingestion_id::text AS ingestion_id, "
                        "projection.organization_id::text AS organization_id, "
                        "projection.store_id::text AS store_id, "
                        "projection.store_code, "
                        "projection.business_portal_id::text AS business_portal_id, "
                        "projection.trade_code_snapshot AS profession_code, "
                        "projection.trade_profile_version, "
                        "projection.captured_by_user_id::text AS captured_by_user_id, "
                        "captured_by.display_name AS captured_by_user_name, "
                        "batch.status, projection.fields, "
                        "COALESCE(("
                        " SELECT jsonb_object_agg(field.field_name, jsonb_build_object("
                        "   'validation_status', field.validation_status,"
                        "   'source', field.source,"
                        "   'confidence', field.combined_confidence,"
                        "   'confidence_band', field.confidence_band,"
                        "   'warnings', field.warnings"
                        " ))"
                        " FROM ingestion.extracted_field AS field"
                        " WHERE field.extraction_run_id = projection.extraction_run_id"
                        "), '{}'::jsonb) AS validation, "
                        "projection.revision_no, "
                        "projection.recorded_at::text AS recorded_at, "
                        "projection.updated_at::text AS updated_at, "
                        "(projection.image_checksum <> '') AS photo_available, "
                        "ingestion.photo_rotation_degrees, "
                        f"{_COMPLETENESS_SQL} AS completeness, "
                        f"{_ALERT_STATE_SQL} AS alert_state, "
                        f"{_ALERT_SEVERITY_SQL} AS alert_severity "
                        "FROM traceability.arrival_projection AS projection "
                        "JOIN traceability.batch AS batch "
                        "ON batch.id = projection.batch_id "
                        "JOIN ingestion.ingestion AS ingestion "
                        "ON ingestion.id = projection.ingestion_id "
                        "LEFT JOIN identity.app_user AS captured_by "
                        "ON captured_by.id = projection.captured_by_user_id "
                        "AND captured_by.organization_id = projection.organization_id "
                        f"WHERE {' AND '.join(conditions)}"
                    ),
                    params,
                )
                .mappings()
                .first()
            )
        if row is None:
            return None
        return CatalogArrival(
            batch_id=row["batch_id"],
            ingestion_id=row["ingestion_id"],
            organization_id=row["organization_id"],
            store_code=row["store_code"],
            status=row["status"],
            fields=row["fields"] or {},
            validation=row["validation"] or {},
            revision_no=int(row["revision_no"]),
            recorded_at=row["recorded_at"],
            updated_at=row["updated_at"],
            photo_available=bool(row["photo_available"]),
            photo_rotation_degrees=int(row["photo_rotation_degrees"]),
            store_id=row["store_id"],
            business_portal_id=row["business_portal_id"],
            profession_code=row["profession_code"],
            trade_profile_version=row["trade_profile_version"],
            captured_by_user_id=row["captured_by_user_id"],
            captured_by_user_name=row["captured_by_user_name"],
            completeness=int(row["completeness"]),
            alert_state=row["alert_state"],
            alert_severity=row["alert_severity"],
        )

    def image_checksum(
        self,
        organization_id: str,
        batch_id: str,
        store_code: str | None,
        access: AccessContext | None = None,
    ) -> str | None:
        if access is None:
            conditions = ["projection.organization_id::text = :organization_id"]
            scope_params: dict[str, object] = {}
        else:
            scope, scope_params = postgres_scope(access, alias="projection")
            conditions = [scope]
        conditions.append("projection.batch_id::text = :batch_id")
        params: dict[str, object] = {
            "organization_id": organization_id,
            "batch_id": batch_id,
            **scope_params,
        }
        if store_code is not None:
            conditions.append("projection.store_code = :store_code")
            params["store_code"] = store_code
        with self._engine.connect() as conn:
            set_tenant_context(conn, organization_id)
            return conn.execute(
                text(
                    "SELECT projection.image_checksum "
                    "FROM traceability.arrival_projection AS projection "
                    f"WHERE {' AND '.join(conditions)}"
                ),
                params,
            ).scalar_one_or_none()
