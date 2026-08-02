"""Tenant-scoped PostgreSQL catalogue projection adapter."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine

from labelscan.contexts.traceability.application.catalog_ports import (
    CatalogFilter,
    CatalogRepository,
)
from labelscan.contexts.traceability.domain.catalog import (
    CatalogArrival,
    CatalogProduct,
)
from labelscan.platform.db.tenant_context import set_tenant_context


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
    )


class SqlCatalogRepository(CatalogRepository):
    def __init__(self, engine: Engine) -> None:
        self._engine = engine

    def list_products(self, filters: CatalogFilter) -> tuple[list[CatalogProduct], int]:
        conditions = ["projection.organization_id = :organization_id"]
        params: dict[str, object] = {
            "organization_id": filters.organization_id,
            "limit": filters.limit,
            "offset": filters.offset,
        }
        if filters.store_code is not None:
            conditions.append("projection.store_code = :store_code")
            params["store_code"] = filters.store_code
        if filters.query is not None:
            conditions.append(
                "("
                "COALESCE(projection.fields->>'commercial_designation', '') "
                "ILIKE :query "
                "OR COALESCE(projection.fields->>'scientific_name', '') ILIKE :query "
                "OR COALESCE(projection.fields->>'gtin', '') ILIKE :query "
                "OR COALESCE(projection.fields->>'batch_number', '') ILIKE :query "
                "OR COALESCE(projection.fields->>'reseller_brand', '') ILIKE :query "
                "OR COALESCE(projection.fields->>'producer_name', '') ILIKE :query"
                ")"
            )
            params["query"] = f"%{filters.query}%"
        if filters.date_from is not None:
            conditions.append("projection.recorded_at >= CAST(:date_from AS date)")
            params["date_from"] = filters.date_from
        if filters.date_to is not None:
            conditions.append(
                "projection.recorded_at < CAST(:date_to AS date) + interval '1 day'"
            )
            params["date_to"] = filters.date_to
        where = f"WHERE {' AND '.join(conditions)}"
        base = (
            "FROM traceability.arrival_projection AS projection "
            "JOIN traceability.batch AS batch ON batch.id = projection.batch_id "
            f"{where}"
        )
        columns = (
            "projection.batch_id::text AS batch_id, projection.store_code, "
            "projection.fields, projection.image_checksum, batch.status, "
            "projection.recorded_at::text AS recorded_at"
        )
        with self._engine.connect() as conn:
            set_tenant_context(conn, filters.organization_id)
            rows = (
                conn.execute(
                    text(
                        f"SELECT {columns}, count(*) OVER() AS total {base} "
                        "ORDER BY projection.recorded_at DESC, projection.batch_id "
                        "LIMIT :limit OFFSET :offset"
                    ),
                    params,
                )
                .mappings()
                .all()
            )
            total = (
                int(rows[0]["total"])
                if rows
                else int(
                    conn.execute(text(f"SELECT count(*) {base}"), params).scalar_one()
                )
            )
        return [_product(row) for row in rows], total

    def get_arrival(
        self, organization_id: str, batch_id: str, store_code: str | None
    ) -> CatalogArrival | None:
        conditions = [
            "projection.organization_id = :organization_id",
            "projection.batch_id::text = :batch_id",
        ]
        params: dict[str, object] = {
            "organization_id": organization_id,
            "batch_id": batch_id,
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
                        "projection.store_code, batch.status, projection.fields, "
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
                        "(projection.image_checksum <> '') AS photo_available "
                        "FROM traceability.arrival_projection AS projection "
                        "JOIN traceability.batch AS batch "
                        "ON batch.id = projection.batch_id "
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
        )

    def image_checksum(
        self, organization_id: str, batch_id: str, store_code: str | None
    ) -> str | None:
        conditions = [
            "organization_id = :organization_id",
            "batch_id::text = :batch_id",
        ]
        params: dict[str, object] = {
            "organization_id": organization_id,
            "batch_id": batch_id,
        }
        if store_code is not None:
            conditions.append("store_code = :store_code")
            params["store_code"] = store_code
        with self._engine.connect() as conn:
            set_tenant_context(conn, organization_id)
            return conn.execute(
                text(
                    "SELECT image_checksum FROM traceability.arrival_projection "
                    f"WHERE {' AND '.join(conditions)}"
                ),
                params,
            ).scalar_one_or_none()
