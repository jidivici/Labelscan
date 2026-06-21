"""Traceability registration consumer (adapter) for `extraction.completed`.

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

    def __init__(self, *, engine: Engine) -> None:
        self._engine = engine

    def __call__(self, msg, conn: Connection) -> None:
        if msg.payload.get("outcome") != "extracted":
            return

        ingestion_id = msg.payload["ingestion_id"]
        run_id = msg.payload["run_id"]
        corr, trace = msg.correlation_id, msg.trace_id

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
        candidate = BatchCandidate(
            lot_code=vals.get("batch_number"),
            scientific_name=vals.get("scientific_name"),
            production_method=vals.get("production_method"),
            fao_area=vals.get("FAO_area"),
            supplier_name=vals.get("supplier_name"),
            use_by=_to_date(vals.get("expiry_date")),
            packaging_date=_to_date(vals.get("packaging_date")),
        )

        conflicting = None
        if candidate.lot_code:
            conflicting = conn.execute(
                text(
                    "SELECT s.name FROM traceability.batch b JOIN traceability.supplier s ON s.id = b.supplier_id "
                    "WHERE b.lot_code = :lot AND s.name <> COALESCE(:sup, '') LIMIT 1"
                ),
                {"lot": candidate.lot_code, "sup": candidate.supplier_name},
            ).scalar_one_or_none()

        issues = check_consistency(candidate, conflicting_supplier_for_lot=conflicting)
        if issues:
            self._flag(conn, ingestion_id, run_id, candidate, issues, corr, trace)
        else:
            self._register(conn, ingestion_id, run_id, candidate, vals, corr, trace)

    def _register(
        self, conn, ingestion_id, run_id, c: BatchCandidate, vals, corr, trace
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
                "(lot_code, product_id, supplier_id, species_scientific, fao_area_code, production_method, "
                " use_by, packaging_date, status, source_ingestion_id, source_extraction_run_id, correlation_id, trace_id) "
                "VALUES (:lot, :pid, :sid, :sci, :fao, :pm, :ub, :pkg, 'registered', :iid, :rid, :corr, :trace) RETURNING id"
            ),
            {
                "lot": c.lot_code,
                "pid": product_id,
                "sid": supplier_id,
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
        self._emit(
            conn,
            "batch.registered",
            {
                "batch_id": str(batch_id),
                "use_by": c.use_by.isoformat() if c.use_by else None,
            },
            corr,
            trace,
        )

    def _flag(
        self, conn, ingestion_id, run_id, c: BatchCandidate, issues, corr, trace
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
                "(lot_code, species_scientific, fao_area_code, production_method, use_by, packaging_date, "
                " status, source_ingestion_id, source_extraction_run_id, correlation_id, trace_id) "
                "VALUES (:lot, :sci, :fao, :pm, :ub, :pkg, 'flagged', :iid, :rid, :corr, :trace) RETURNING id"
            ),
            {
                "lot": c.lot_code,
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
        self._emit(
            conn,
            "batch.flagged",
            {"batch_id": str(batch_id), "issues": list(issues)},
            corr,
            trace,
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
