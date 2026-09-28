"""V3 retirement must preserve V1/V2 contracts and immutable stored history."""

import importlib.util
import json
import uuid
from pathlib import Path

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import text

from labelscan.business_profiles import TRADE_PROFILES, trade_profile
from labelscan.contexts.ingestion.adapters.claude_llm_provider import _system_text_for
from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.application.submit_ingestion import (
    SubmitIngestionCommand,
)
from labelscan.contexts.ingestion.domain.extraction import RuleSet
from labelscan.platform.outbox.worker import OutboxWorker
from tests._fakes import FakeLlm, FakeOcr, field
from tests.conftest import ACTOR_ID


@pytest.mark.parametrize("code", TRADE_PROFILES)
def test_retired_fields_only_belong_to_historical_profiles(code):
    current = trade_profile(code)
    assert current.version == "3"
    assert not {"expiry_date", "gtin", "price"}.intersection(current.fields)
    assert set(current.required_fields) <= set(current.fields)
    assert "expiry_date" not in _system_text_for(current)
    assert "gtin" not in _system_text_for(current)
    for version in ("1", "2"):
        historical = trade_profile(code, version)
        assert {"expiry_date", "gtin"} <= set(historical.fields)
        assert "expiry_date" in historical.required_fields


@pytest.mark.parametrize("version", ["2", "3"])
def test_gs1_and_ocr_follow_the_stored_profile(submit, engine, raw_store, version):
    with engine.begin() as conn:
        conn.execute(text("UPDATE platform.outbox SET published_at = now() WHERE published_at IS NULL"))
    ingestion = submit(SubmitIngestionCommand(
        image_bytes=f"retired-fields-{uuid.uuid4()}".encode(),
        content_type="image/jpeg", actor_id=ACTOR_ID,
        correlation_id="retired-fields", trace_id="retired-fields", principal="retired-fields",
        barcode_raw="(01)03700161210047(17)261231(10)LOT123",
        trade_profile_version=version,
    ))
    consumer = ExtractionConsumer(
        engine=engine, raw_store=raw_store,
        ocr=FakeOcr("Gadus morhua Wild caught DLC 31/12/2026 Packed on 2026-09-28"),
        llm=FakeLlm((
            field("scientific_name", "Gadus morhua", evidence=["Gadus morhua"]),
            field("production_method", "wild_caught", evidence=["Wild caught"]),
        )),
        rule_set=RuleSet(version="test", required_fields=frozenset({"scientific_name", "production_method", "expiry_date"})),
    )
    worker = OutboxWorker(engine)
    worker.register(consumer.event_type, consumer.consumer_name, consumer)
    worker.run_once()
    with engine.connect() as conn:
        fields = dict(conn.execute(text(
            "SELECT field_name, value FROM ingestion.extracted_field f "
            "JOIN ingestion.extraction_run r ON r.id = f.extraction_run_id "
            "WHERE r.ingestion_id = :id"
        ), {"id": ingestion.ingestion_id}).all())
        assert fields["batch_number"] == "LOT123"
        assert conn.execute(text("SELECT status FROM ingestion.ingestion WHERE id = :id"), {"id": ingestion.ingestion_id}).scalar_one() == "extracted"
        if version == "2":
            assert fields["expiry_date"] == "2026-12-31"
            assert fields["gtin"] == "03700161210047"
        else:
            assert not {"expiry_date", "gtin"}.intersection(fields)
            previews = set(conn.execute(text("SELECT field_name FROM ingestion.interim_field WHERE ingestion_id = :id"), {"id": ingestion.ingestion_id}).scalars())
            assert "expiry_date" not in previews
            assert "packaging_date" in previews


def test_migration_round_trip_preserves_all_records(conn):
    path = Path(__file__).parents[1] / "migrations/versions/0039_retire_dlc_gtin.py"
    spec = importlib.util.spec_from_file_location("retire_fields", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tables = ("ingestion.ingestion", "ingestion.extracted_field", "ingestion.interim_field", "traceability.batch", "traceability.arrival_projection", "audit.audit_log")

    def snapshot():
        return {
            table: sorted(json.dumps(row[0], sort_keys=True) for row in conn.execute(text(f"SELECT to_jsonb(t) FROM {table} t")))
            for table in tables
        }

    def defaults():
        return conn.execute(text("SELECT column_default FROM information_schema.columns WHERE column_name = 'trade_profile_version' AND table_schema IN ('ingestion', 'traceability')")).scalars().all()

    with conn.begin():
        before = snapshot()
        assert defaults() == ["'3'::text"] * 3
        with Operations.context(MigrationContext.configure(conn)):
            module.downgrade()
            assert defaults() == ["'2'::text"] * 3
            assert snapshot() == before
            module.upgrade()
        assert defaults() == ["'3'::text"] * 3
        assert snapshot() == before
