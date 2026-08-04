"""Traceability registration consumer for extracted or human-reviewed labels.

Consumes ONLY validated extractions (outcome == 'extracted'); needs_review or
failed runs never produce a batch. Applies the domain-truth consistency checks,
then either registers the full chain (product -> supplier -> batch -> source run
-> source ingestion) and emits `batch.registered`, or records a FLAGGED batch and
emits `batch.flagged` — never silently accepting/correcting bad data, never
mutating. HACCP alerting is a separate context that consumes those events, so
this consumer imports no other context (boundary stays clean).
"""

from __future__ import annotations

import json
from datetime import date

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from labelscan.contexts.traceability.domain.consistency import (
    BatchCandidate,
    check_consistency,
)
from labelscan.platform.db.audit_context import set_audit_context

SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000001"


def _to_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except (ValueError, TypeError):
        # malformed date string (ValueError) or non-string value (TypeError) —
        # treat as "no date" rather than crashing the consumer.
        return None


class RegistrationConsumer:
    consumer_name = "traceability"
    event_type = "extraction.completed"
    review_event_type = "review.finalized"

    def __init__(self, *, engine: Engine) -> None:
        self._engine = engine

    def __call__(self, msg, conn: Connection) -> None:
        # An automatic run may be trusted immediately only when its extracted
        # outcome passed the gate. A human final review produces a new extracted
        # run, but intentionally emits ``review.finalized`` (so the audit trail
        # distinguishes a human decision from an automatic result). Both are
        # valid sources for registering a batch.
        if msg.event_type == self.event_type:
            if msg.payload.get("outcome") != "extracted":
                return
        elif msg.event_type != self.review_event_type:
            return

        ingestion_id = msg.payload["ingestion_id"]
        run_id = msg.payload["run_id"]
        corr, trace = msg.correlation_id, msg.trace_id
        tenant = (
            conn.execute(
                text(
                    "SELECT organization_id::text AS organization_id, "
                    "store_id::text AS store_id, store_code, "
                    "business_portal_id::text AS business_portal_id, "
                    "trade_code_snapshot, trade_profile_version, "
                    "captured_by_user_id::text AS captured_by_user_id "
                    "FROM ingestion.ingestion WHERE id = :ingestion_id"
                ),
                {"ingestion_id": ingestion_id},
            )
            .mappings()
            .one()
        )

        vals = {
            r["field_name"]: r["value"]
            for r in conn.execute(
                text(
                    "SELECT field_name, value FROM ingestion.extracted_field WHERE extraction_run_id = :r"
                ),
                {"r": run_id},
            )
            .mappings()
            .all()
        }

        # The usual path is: automatic extraction -> one registration. If an
        # operator later finalizes an already extracted item, the separate review
        # projection consumer refreshes its fields. Never create a second batch
        # for that same ingestion.
        already_registered = conn.execute(
            text(
                "SELECT 1 FROM traceability.batch "
                "WHERE organization_id = :organization_id "
                "AND source_ingestion_id = :ingestion_id LIMIT 1"
            ),
            {
                "organization_id": tenant["organization_id"],
                "ingestion_id": ingestion_id,
            },
        ).scalar_one_or_none()
        if already_registered is not None:
            return

        candidate = BatchCandidate(
            lot_code=vals.get("batch_number"),
            scientific_name=vals.get("scientific_name"),
            production_method=vals.get("production_method"),
            fao_area=vals.get("FAO_area"),
            # Prompt v2 split supplier_name -> reseller_brand (the immediate FBO/distributor,
            # i.e. the one-step-back supplier for traceability) + producer_name (provenance).
            # Fall back to the legacy field for v1 historical runs.
            supplier_name=(
                vals.get("reseller_brand")
                or vals.get("producer_name")
                or vals.get("supplier_name")
            ),
            use_by=_to_date(vals.get("expiry_date")),
            packaging_date=_to_date(vals.get("packaging_date")),
        )

        conflicting = None
        if candidate.lot_code:
            conflicting = conn.execute(
                text(
                    "SELECT s.name FROM traceability.batch b JOIN traceability.supplier s ON s.id = b.supplier_id "
                    "WHERE b.organization_id = :organization_id "
                    "AND b.lot_code = :lot AND s.name <> COALESCE(:sup, '') LIMIT 1"
                ),
                {
                    "organization_id": tenant["organization_id"],
                    "lot": candidate.lot_code,
                    "sup": candidate.supplier_name,
                },
            ).scalar_one_or_none()

        issues = check_consistency(candidate, conflicting_supplier_for_lot=conflicting)
        if issues:
            # A repeated scan of an already-flagged physical lot must not poison
            # the outbox on the batch uniqueness constraint. It is still retained
            # as an ingestion/audit record; the catalogue deliberately keeps one
            # flagged batch per lot rather than inventing duplicate stock.
            if self._has_flagged_lot(
                conn,
                tenant["organization_id"],
                tenant["business_portal_id"],
                candidate.lot_code,
            ):
                return
            self._flag(
                conn,
                ingestion_id,
                run_id,
                tenant,
                candidate,
                issues,
                corr,
                trace,
            )
        else:
            # Same physical lot scanned twice: keep the second capture in the
            # immutable ingestion history, but do not create a duplicate batch
            # card (the database enforces one supplier/product/lot identity).
            if self._has_registered_batch(
                conn,
                tenant["organization_id"],
                tenant["business_portal_id"],
                candidate,
                vals,
            ):
                return
            self._register(
                conn,
                ingestion_id,
                run_id,
                tenant,
                candidate,
                vals,
                corr,
                trace,
            )

    @staticmethod
    def _has_flagged_lot(conn, organization_id, business_portal_id, lot_code) -> bool:
        return (
            conn.execute(
                text(
                    "SELECT 1 FROM traceability.batch "
                    "WHERE organization_id = :organization_id "
                    "AND business_portal_id IS NOT DISTINCT FROM :business_portal_id "
                    "AND status = 'flagged' "
                    "AND lot_code IS NOT DISTINCT FROM :lot_code LIMIT 1"
                ),
                {
                    "organization_id": organization_id,
                    "business_portal_id": business_portal_id,
                    "lot_code": lot_code,
                },
            ).scalar_one_or_none()
            is not None
        )

    @staticmethod
    def _has_registered_batch(
        conn, organization_id, business_portal_id, candidate, values
    ) -> bool:
        return (
            conn.execute(
                text(
                    "SELECT 1 FROM traceability.batch AS batch "
                    "LEFT JOIN traceability.supplier AS supplier ON supplier.id = batch.supplier_id "
                    "LEFT JOIN traceability.product AS product ON product.id = batch.product_id "
                    "WHERE batch.organization_id = :organization_id "
                    "AND batch.business_portal_id IS NOT DISTINCT FROM :business_portal_id "
                    "AND batch.status = 'registered' "
                    "AND batch.lot_code IS NOT DISTINCT FROM :lot_code "
                    "AND COALESCE(supplier.name, '') = COALESCE(:supplier_name, '') "
                    "AND COALESCE(product.common_name, '') = COALESCE(:common_name, '') "
                    "AND COALESCE(product.scientific_name, '') = COALESCE(:scientific_name, '') "
                    "LIMIT 1"
                ),
                {
                    "organization_id": organization_id,
                    "business_portal_id": business_portal_id,
                    "lot_code": candidate.lot_code,
                    "supplier_name": candidate.supplier_name,
                    "common_name": values.get("commercial_designation")
                    or values.get("product_name"),
                    "scientific_name": candidate.scientific_name,
                },
            ).scalar_one_or_none()
            is not None
        )

    def _register(
        self,
        conn,
        ingestion_id,
        run_id,
        tenant,
        c: BatchCandidate,
        vals,
        corr,
        trace,
    ) -> None:
        set_audit_context(
            conn,
            actor_id=SYSTEM_ACTOR,
            action="traceability.batch_registered",
            correlation_id=corr,
            trace_id=trace,
        )
        product_id = self._find_or_create_product(
            conn,
            common=vals.get("commercial_designation") or vals.get("product_name"),
            scientific=c.scientific_name,
            corr=corr,
            trace=trace,
        )
        supplier_id = self._find_or_create_supplier(
            conn, name=c.supplier_name, corr=corr, trace=trace
        )
        batch_id = conn.execute(
            text(
                "INSERT INTO traceability.batch "
                "(organization_id, store_id, business_portal_id, trade_code_snapshot, "
                " trade_profile_version, captured_by_user_id, lot_code, product_id, supplier_id, store_code, "
                " species_scientific, fao_area_code, production_method, "
                " use_by, packaging_date, status, source_ingestion_id, source_extraction_run_id, correlation_id, trace_id) "
                "VALUES (:org, :store_id, :business_portal_id, :trade_code_snapshot, "
                " :trade_profile_version, :captured_by_user_id, :lot, :pid, :sid, :store, :sci, :fao, :pm, "
                " :ub, :pkg, 'registered', :iid, :rid, :corr, :trace) RETURNING id"
            ),
            {
                "org": tenant["organization_id"],
                "store_id": tenant["store_id"],
                "business_portal_id": tenant["business_portal_id"],
                "trade_code_snapshot": tenant["trade_code_snapshot"],
                "trade_profile_version": tenant["trade_profile_version"],
                "captured_by_user_id": tenant["captured_by_user_id"],
                "lot": c.lot_code,
                "pid": product_id,
                "sid": supplier_id,
                "store": tenant["store_code"],
                "sci": c.scientific_name,
                "fao": c.fao_area,
                "pm": c.production_method,
                "ub": c.use_by,
                "pkg": c.packaging_date,
                "iid": ingestion_id,
                "rid": run_id,
                "corr": corr,
                "trace": trace,
            },
        ).scalar_one()
        self._write_projection(
            conn,
            batch_id=batch_id,
            ingestion_id=ingestion_id,
            organization_id=tenant["organization_id"],
            store_id=tenant["store_id"],
            store_code=tenant["store_code"],
            business_portal_id=tenant["business_portal_id"],
            trade_code_snapshot=tenant["trade_code_snapshot"],
            trade_profile_version=tenant["trade_profile_version"],
            captured_by_user_id=tenant["captured_by_user_id"],
        )
        self._emit(
            conn,
            "batch.registered",
            {
                "batch_id": str(batch_id),
                "use_by": c.use_by.isoformat() if c.use_by else None,
                "organization_id": tenant["organization_id"],
                "store_id": tenant["store_id"],
                "business_portal_id": tenant["business_portal_id"],
                "trade_code_snapshot": tenant["trade_code_snapshot"],
                "trade_profile_version": tenant["trade_profile_version"],
            },
            corr,
            trace,
        )

    def _flag(
        self,
        conn,
        ingestion_id,
        run_id,
        tenant,
        c: BatchCandidate,
        issues,
        corr,
        trace,
    ) -> None:
        set_audit_context(
            conn,
            actor_id=SYSTEM_ACTOR,
            action="traceability.batch_flagged",
            correlation_id=corr,
            trace_id=trace,
        )
        batch_id = conn.execute(
            text(
                "INSERT INTO traceability.batch "
                "(organization_id, store_id, business_portal_id, trade_code_snapshot, "
                " trade_profile_version, captured_by_user_id, lot_code, store_code, species_scientific, "
                " fao_area_code, production_method, use_by, packaging_date, "
                " status, source_ingestion_id, source_extraction_run_id, correlation_id, trace_id) "
                "VALUES (:org, :store_id, :business_portal_id, :trade_code_snapshot, "
                " :trade_profile_version, :captured_by_user_id, :lot, :store, :sci, :fao, :pm, :ub, :pkg, "
                " 'flagged', :iid, :rid, :corr, :trace) RETURNING id"
            ),
            {
                "org": tenant["organization_id"],
                "store_id": tenant["store_id"],
                "business_portal_id": tenant["business_portal_id"],
                "trade_code_snapshot": tenant["trade_code_snapshot"],
                "trade_profile_version": tenant["trade_profile_version"],
                "captured_by_user_id": tenant["captured_by_user_id"],
                "lot": c.lot_code,
                "store": tenant["store_code"],
                "sci": c.scientific_name,
                "fao": c.fao_area,
                "pm": c.production_method,
                "ub": c.use_by,
                "pkg": c.packaging_date,
                "iid": ingestion_id,
                "rid": run_id,
                "corr": corr,
                "trace": trace,
            },
        ).scalar_one()
        self._write_projection(
            conn,
            batch_id=batch_id,
            ingestion_id=ingestion_id,
            organization_id=tenant["organization_id"],
            store_id=tenant["store_id"],
            store_code=tenant["store_code"],
            business_portal_id=tenant["business_portal_id"],
            trade_code_snapshot=tenant["trade_code_snapshot"],
            trade_profile_version=tenant["trade_profile_version"],
            captured_by_user_id=tenant["captured_by_user_id"],
        )
        self._emit(
            conn,
            "batch.flagged",
            {
                "batch_id": str(batch_id),
                "issues": list(issues),
                "organization_id": tenant["organization_id"],
                "store_id": tenant["store_id"],
                "business_portal_id": tenant["business_portal_id"],
                "trade_code_snapshot": tenant["trade_code_snapshot"],
                "trade_profile_version": tenant["trade_profile_version"],
            },
            corr,
            trace,
        )

    @staticmethod
    def _write_projection(
        conn,
        *,
        batch_id,
        ingestion_id,
        organization_id,
        store_id,
        store_code,
        business_portal_id,
        trade_code_snapshot,
        trade_profile_version,
        captured_by_user_id,
    ) -> None:
        """Publish the latest immutable revision into the mutable read model.

        If a mobile review raced ahead of this consumer, selecting the latest run
        here guarantees that the first catalogue row already shows the human
        revision rather than the stale machine extraction.
        """
        conn.execute(
            text(
                """
                INSERT INTO traceability.arrival_projection (
                    batch_id, organization_id, store_id, store_code, ingestion_id,
                    business_portal_id, trade_code_snapshot, trade_profile_version,
                    captured_by_user_id, extraction_run_id, fields, image_ref,
                    image_checksum, recorded_at
                )
                SELECT
                    :batch_id, :organization_id, :store_id, :store_code, i.id,
                    :business_portal_id, :trade_code_snapshot, :trade_profile_version,
                    :captured_by_user_id,
                    latest.id,
                    COALESCE((
                        SELECT jsonb_object_agg(f.field_name, f.value)
                        FROM ingestion.extracted_field AS f
                        WHERE f.extraction_run_id = latest.id
                    ), '{}'::jsonb),
                    i.image_ref, i.checksum_sha256, i.server_received_at
                FROM ingestion.ingestion AS i
                JOIN LATERAL (
                    SELECT r.id
                    FROM ingestion.extraction_run AS r
                    WHERE r.ingestion_id = i.id
                    ORDER BY r.attempt_no DESC
                    LIMIT 1
                ) AS latest ON true
                WHERE i.id = :ingestion_id
                ON CONFLICT (batch_id) DO UPDATE
                SET extraction_run_id = EXCLUDED.extraction_run_id,
                    fields = EXCLUDED.fields,
                    revision_no = traceability.arrival_projection.revision_no + 1,
                    image_ref = EXCLUDED.image_ref,
                    image_checksum = EXCLUDED.image_checksum,
                    updated_at = clock_timestamp()
                """
            ),
            {
                "batch_id": batch_id,
                "organization_id": organization_id,
                "store_id": store_id,
                "store_code": store_code,
                "business_portal_id": business_portal_id,
                "trade_code_snapshot": trade_code_snapshot,
                "trade_profile_version": trade_profile_version,
                "captured_by_user_id": captured_by_user_id,
                "ingestion_id": ingestion_id,
            },
        )

    def _emit(self, conn, event_type, payload, corr, trace) -> None:
        conn.execute(
            text(
                "INSERT INTO platform.outbox (event_type, payload, correlation_id, trace_id) "
                "VALUES (:et, CAST(:p AS jsonb), :corr, :trace)"
            ),
            {"et": event_type, "p": json.dumps(payload), "corr": corr, "trace": trace},
        )

    def _find_or_create_supplier(self, conn, *, name, corr, trace):
        if not name:
            return None
        sid = conn.execute(
            text(
                "INSERT INTO traceability.supplier (name, correlation_id, trace_id) VALUES (:n, :c, :t) "
                "ON CONFLICT (name) DO NOTHING RETURNING id"
            ),
            {"n": name, "c": corr, "t": trace},
        ).scalar_one_or_none()
        if sid is None:
            sid = conn.execute(
                text("SELECT id FROM traceability.supplier WHERE name = :n"),
                {"n": name},
            ).scalar_one()
        return sid

    def _find_or_create_product(self, conn, *, common, scientific, corr, trace):
        if not common and not scientific:
            return None
        pid = conn.execute(
            text(
                "INSERT INTO traceability.product (common_name, scientific_name, gtin, correlation_id, trace_id) "
                "VALUES (:cn, :sn, NULL, :c, :t) ON CONFLICT (common_name, scientific_name, gtin) DO NOTHING RETURNING id"
            ),
            {"cn": common, "sn": scientific, "c": corr, "t": trace},
        ).scalar_one_or_none()
        if pid is None:
            pid = conn.execute(
                text(
                    "SELECT id FROM traceability.product WHERE common_name IS NOT DISTINCT FROM :cn "
                    "AND scientific_name IS NOT DISTINCT FROM :sn AND gtin IS NULL"
                ),
                {"cn": common, "sn": scientific},
            ).scalar_one()
        return pid
