"""PG-5 proofs (integration) — traceability chain + domain-truth flagging.

- validated extraction -> product/supplier/batch registered, full chain queryable
- expiry CCP raises an alert
- inconsistent data (supplier mismatch) -> FLAGGED batch + inconsistency alert
- traceability records are append-only (immutable)
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from labelscan.contexts.haccp.adapters.alerting_consumer import AlertingConsumer
from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.application.submit_ingestion import (
    SubmitIngestionCommand,
)
from labelscan.contexts.traceability.adapters.registration_consumer import (
    RegistrationConsumer,
)
from labelscan.contexts.traceability.domain.consistency import (
    BatchCandidate,
    check_consistency,
)
from labelscan.contexts.ingestion.domain.extraction import RuleSet
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.outbox.worker import OutboxWorker
from tests._fakes import FakeLlm, FakeOcr, traceable_fields
from tests.conftest import ACTOR_ID

RULES = RuleSet(
    version="test",
    required_fields=frozenset({"scientific_name", "expiry_date", "production_method"}),
)


def _cmd(content: bytes) -> SubmitIngestionCommand:
    return SubmitIngestionCommand(
        image_bytes=content,
        content_type="image/jpeg",
        actor_id=ACTOR_ID,
        correlation_id="corr-tr",
        trace_id="trace-tr",
        principal="device-01",
        store_code="TEST-MAG-01",
    )


def _quiesce(engine):
    with engine.begin() as c:
        c.execute(
            text(
                "UPDATE platform.outbox SET published_at = now() WHERE published_at IS NULL"
            )
        )


def _seed_expiry_plan(engine):
    version = f"expiry-plan-{uuid.uuid4().hex[:8]}"
    with engine.begin() as c:
        set_audit_context(
            c,
            actor_id=ACTOR_ID,
            action="haccp.plan_created",
            correlation_id="c",
            trace_id="t",
        )
        c.execute(
            text(
                "INSERT INTO haccp.control_plan (version, expiry_warning_days, active, correlation_id, trace_id) "
                "VALUES (:v, 7, true, 'c', 't')"
            ),
            {"v": version},
        )


def _full_worker(engine, raw_store, ocr, llm, today: date) -> OutboxWorker:
    w = OutboxWorker(engine)
    ext = ExtractionConsumer(
        engine=engine, raw_store=raw_store, ocr=ocr, llm=llm, rule_set=RULES
    )
    w.register(ext.event_type, ext.consumer_name, ext)
    reg = RegistrationConsumer(engine=engine)
    w.register(reg.event_type, reg.consumer_name, reg)
    al = AlertingConsumer(engine=engine, today=lambda: today)
    for et in al.event_types:
        w.register(et, al.consumer_name, al)
    return w


def test_supplier_mismatch_pure():
    cand = BatchCandidate(
        lot_code="L1",
        scientific_name="x",
        production_method="wild_caught",
        fao_area="27",
        supplier_name="Beta",
        use_by=None,
        packaging_date=None,
    )
    assert "supplier_mismatch" in check_consistency(
        cand, conflicting_supplier_for_lot="Alpha"
    )
    assert check_consistency(cand, conflicting_supplier_for_lot="Beta") == ()


def test_full_chain_registered_and_queryable(submit, engine, raw_store):
    _seed_expiry_plan(engine)
    _quiesce(engine)
    res = submit(_cmd(b"trace-chain-1"))
    _full_worker(
        engine,
        raw_store,
        FakeOcr(),
        FakeLlm(traceable_fields()),
        today=date(2026, 6, 18),
    ).run_once()

    with engine.connect() as c:
        chain = (
            c.execute(
                text(
                    "SELECT b.id AS batch_id, b.status, b.store_code, b.lot_code, "
                    "s.name AS supplier, p.scientific_name AS sci, "
                    "       r.outcome, i.status AS ing_status, ra.id AS image_id "
                    "FROM traceability.batch b "
                    "JOIN traceability.supplier s ON s.id = b.supplier_id "
                    "JOIN traceability.product p ON p.id = b.product_id "
                    "JOIN ingestion.extraction_run r ON r.id = b.source_extraction_run_id "
                    "JOIN ingestion.ingestion i ON i.id = b.source_ingestion_id "
                    "JOIN ingestion.raw_artifact ra ON ra.ingestion_id = i.id AND ra.artifact_kind = 'image' "
                    "WHERE b.source_ingestion_id = :iid"
                ),
                {"iid": res.ingestion_id},
            )
            .mappings()
            .all()
        )

    assert len(chain) == 1
    row = chain[0]
    assert row["status"] == "registered"
    assert row["store_code"] == "TEST-MAG-01"
    assert row["supplier"] == "Nordic Seafood AS"
    assert row["sci"] == "Gadus morhua"
    assert row["outcome"] == "extracted"
    assert row["ing_status"] == "extracted"
    assert (
        row["image_id"] is not None
    )  # full chain product->supplier->run->ingestion->raw image

    with engine.connect() as c:
        # audit chain: the batch registration is audited
        audited = c.execute(
            text("SELECT count(*) FROM audit.audit_log WHERE subject_id = :b"),
            {"b": row["batch_id"]},
        ).scalar_one()
        # expiry CCP fired (use_by 2026-06-20, today 2026-06-18, 7-day window)
        expiry_alerts = c.execute(
            text(
                "SELECT count(*) FROM haccp.alert WHERE batch_id = :b AND alert_type = 'expiry' AND state = 'open'"
            ),
            {"b": row["batch_id"]},
        ).scalar_one()
    assert audited >= 1
    assert expiry_alerts == 1


def test_supplier_mismatch_flags_batch_and_alerts(submit, engine, raw_store):
    _quiesce(engine)
    text_a = (
        "Cod (Gadus morhua) Supplier Alpha Foods Wild caught FAO area 27 "
        "Use by 2026-06-20 Packed on 2026-06-10 Lot LOTX Atlantic Cod"
    )
    text_b = (
        "Cod (Gadus morhua) Supplier Beta Foods Wild caught FAO area 27 "
        "Use by 2026-06-20 Packed on 2026-06-10 Lot LOTX Atlantic Cod"
    )

    res_a = submit(_cmd(b"trace-mismatch-A"))
    _full_worker(
        engine,
        raw_store,
        FakeOcr(text_a),
        FakeLlm(traceable_fields(lot="LOTX", supplier="Alpha Foods")),
        today=date(2026, 6, 1),
    ).run_once()

    _quiesce(engine)
    res_b = submit(_cmd(b"trace-mismatch-B"))
    _full_worker(
        engine,
        raw_store,
        FakeOcr(text_b),
        FakeLlm(traceable_fields(lot="LOTX", supplier="Beta Foods")),
        today=date(2026, 6, 1),
    ).run_once()

    with engine.connect() as c:
        status_a = c.execute(
            text(
                "SELECT status FROM traceability.batch WHERE source_ingestion_id = :i"
            ),
            {"i": res_a.ingestion_id},
        ).scalar_one()
        batch_b = (
            c.execute(
                text(
                    "SELECT id, status FROM traceability.batch WHERE source_ingestion_id = :i"
                ),
                {"i": res_b.ingestion_id},
            )
            .mappings()
            .one()
        )
        alert = (
            c.execute(
                text(
                    "SELECT detail FROM haccp.alert WHERE batch_id = :b AND alert_type = 'inconsistency'"
                ),
                {"b": batch_b["id"]},
            )
            .mappings()
            .one()
        )

    assert status_a == "registered"
    assert batch_b["status"] == "flagged"  # inconsistent data not silently accepted
    assert "supplier_mismatch" in alert["detail"]["issues"]


def test_batch_is_append_only(submit, engine, raw_store):
    _seed_expiry_plan(engine)
    _quiesce(engine)
    text_imm = (
        "Cod (Gadus morhua) Supplier Immco Wild caught FAO area 27 "
        "Use by 2026-06-20 Packed on 2026-06-10 Lot IMMUT1 Atlantic Cod"
    )
    res = submit(_cmd(b"trace-immutable-1"))
    _full_worker(
        engine,
        raw_store,
        FakeOcr(text_imm),
        FakeLlm(traceable_fields(lot="IMMUT1", supplier="Immco")),
        today=date(2026, 6, 1),
    ).run_once()

    with engine.connect() as c:
        batch_id = c.execute(
            text("SELECT id FROM traceability.batch WHERE source_ingestion_id = :i"),
            {"i": res.ingestion_id},
        ).scalar_one()
    with pytest.raises(DBAPIError) as ei:
        with engine.begin() as c:
            c.execute(
                text(
                    "UPDATE traceability.batch SET status = 'registered' WHERE id = :id"
                ),
                {"id": batch_id},
            )
    assert "append-only" in str(ei.value).lower()
