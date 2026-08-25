"""Profile-aware extraction and complete-review contract proofs."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from labelscan.business_profiles import TRADE_PROFILES, trade_profile
from labelscan.contexts.ingestion.adapters.claude_llm_provider import (
    _output_schema,
    _system_text_for,
)
from labelscan.contexts.ingestion.adapters.extraction_consumer import ExtractionConsumer
from labelscan.contexts.ingestion.adapters.sql_review_repository import (
    SqlReviewRepository,
)
from labelscan.contexts.ingestion.application.finalize_review import (
    FinalizeReview,
    FinalizeReviewCommand,
    InvalidReviewFields,
)
from labelscan.contexts.ingestion.application.override_field import FIELD_NAMES
from labelscan.contexts.ingestion.application.ports import FinalizedReview
from labelscan.contexts.ingestion.application.submit_ingestion import (
    SubmitIngestionCommand,
)
from labelscan.contexts.ingestion.domain.extraction import RuleSet
from labelscan.platform.db.audit_context import set_audit_context
from labelscan.platform.outbox.worker import OutboxWorker
from tests._fakes import FakeLlm, FakeOcr, field
from tests.conftest import ACTOR_ID


class _ReviewRepository:
    def __init__(self) -> None:
        self.fields = None

    def finalize(self, **kwargs):
        self.fields = kwargs["fields"]
        return FinalizedReview(
            ingestion_id=kwargs["ingestion_id"],
            run_id="run-1",
            status="confirmed",
            replayed=False,
        )


def _review_command(fields: dict[str, str | None]) -> FinalizeReviewCommand:
    return FinalizeReviewCommand(
        ingestion_id="ingestion-1",
        organization_id="organization-1",
        fields=fields,
        idempotency_key="review-1",
        actor_id=ACTOR_ID,
        correlation_id="correlation-1",
        trace_id="trace-1",
    )


def test_v2_registry_contains_every_requested_trade_field_without_price() -> None:
    assert {
        "animal_species",
        "cut_name",
        "birth_country",
        "rearing_country",
        "slaughter_country",
        "slaughterhouse_approval",
        "cutting_plant_approval",
    }.issubset(trade_profile("boucherie").specific_fields)
    assert {
        "product_family",
        "manufacturer_name",
        "preparation_date",
        "conditioning_type",
        "storage_mode",
        "use_instructions",
        "reheating_instructions",
        "ingredients",
        "additives",
    }.issubset(trade_profile("charcuterie_traiteur").specific_fields)
    assert all("price" not in profile.fields for profile in TRADE_PROFILES.values())
    assert "price" in trade_profile("poissonnerie", "1").fields


@pytest.mark.parametrize("trade_code", ["boucherie", "charcuterie_traiteur"])
def test_llm_schema_and_prompt_are_built_from_the_selected_profile(
    trade_code: str,
) -> None:
    profile = trade_profile(trade_code)
    schema = _output_schema(profile.fields)
    fields_schema = schema["properties"]["fields"]
    assert "minItems" not in fields_schema
    assert "maxItems" not in fields_schema
    assert fields_schema["items"]["properties"]["name"]["enum"] == list(profile.fields)
    prompt = _system_text_for(profile)
    assert profile.display_name in prompt
    assert all(field_name in prompt for field_name in profile.specific_fields)
    assert "FAO_area" not in prompt


@pytest.mark.parametrize(
    "trade_code", ["poissonnerie", "boucherie", "charcuterie_traiteur"]
)
def test_final_review_accepts_each_exact_versioned_contract(trade_code: str) -> None:
    fields = {name: "NC" for name in trade_profile(trade_code).fields}
    repository = _ReviewRepository()
    result = FinalizeReview(repository)(_review_command(fields))
    assert result.status == "confirmed"
    assert repository.fields == fields


def test_final_review_rejects_a_mixed_trade_contract() -> None:
    fields = {name: None for name in trade_profile("boucherie").fields}
    fields["FAO_area"] = "27"
    with pytest.raises(InvalidReviewFields):
        FinalizeReview(_ReviewRepository())(_review_command(fields))


def test_override_allow_list_is_the_profile_union_plus_legacy_names() -> None:
    expected = {
        field_name
        for profile in TRADE_PROFILES.values()
        for field_name in profile.fields
    }
    assert expected.issubset(FIELD_NAMES)
    assert {"product_name", "supplier_name", "price"}.issubset(FIELD_NAMES)


@pytest.mark.parametrize(
    ("trade_code", "ocr_text", "fields"),
    [
        (
            "boucherie",
            "Boeuf Entrecote France Use by 2026-08-30",
            (
                field("animal_species", "Boeuf", evidence=["Boeuf"]),
                field("cut_name", "Entrecote", evidence=["Entrecote"]),
                field("expiry_date", "2026-08-30", evidence=["2026-08-30"]),
            ),
        ),
        (
            "charcuterie_traiteur",
            "Jambon cuit Ingredients porc sel Use by 2026-08-30",
            (
                field(
                    "commercial_designation",
                    "Jambon cuit",
                    evidence=["Jambon cuit"],
                ),
                field("ingredients", "porc sel", evidence=["porc sel"]),
                field("expiry_date", "2026-08-30", evidence=["2026-08-30"]),
            ),
        ),
    ],
)
def test_consumer_uses_ingestion_profile_without_fish_requirements(
    submit,
    engine,
    raw_store,
    trade_code: str,
    ocr_text: str,
    fields,
) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE platform.outbox SET published_at = now() WHERE published_at IS NULL"
            )
        )
    ingestion = submit(
        SubmitIngestionCommand(
            image_bytes=f"profile-{trade_code}-{uuid.uuid4()}".encode(),
            content_type="image/jpeg",
            actor_id=ACTOR_ID,
            correlation_id="correlation-profile",
            trace_id="trace-profile",
            principal=f"device-{uuid.uuid4()}",
            trade_code_snapshot=trade_code,
            trade_profile_version="1",
        )
    )
    llm = FakeLlm(fields)
    consumer = ExtractionConsumer(
        engine=engine,
        raw_store=raw_store,
        ocr=FakeOcr(ocr_text),
        llm=llm,
        rule_set=RuleSet(
            version="fish-only-test",
            required_fields=frozenset(
                {"scientific_name", "production_method", "expiry_date"}
            ),
        ),
    )
    worker = OutboxWorker(engine)
    worker.register(consumer.event_type, consumer.consumer_name, consumer)
    worker.run_once()

    with engine.connect() as conn:
        run = (
            conn.execute(
                text(
                    "SELECT outcome, rule_set_version FROM ingestion.extraction_run "
                    "WHERE ingestion_id = :ingestion_id"
                ),
                {"ingestion_id": ingestion.ingestion_id},
            )
            .mappings()
            .one()
        )
        stored_fields = set(
            conn.execute(
                text(
                    "SELECT field_name FROM ingestion.extracted_field "
                    "WHERE extraction_run_id = ("
                    "SELECT id FROM ingestion.extraction_run "
                    "WHERE ingestion_id = :ingestion_id)"
                ),
                {"ingestion_id": ingestion.ingestion_id},
            ).scalars()
        )
    assert run["outcome"] == "extracted"
    assert run["rule_set_version"] == f"trade-profile:{trade_code}:v1"
    assert stored_fields == {value.name for value in fields}
    assert llm.last_trade_code == trade_code
    assert llm.last_trade_profile_version == "1"


@pytest.mark.parametrize("trade_code", ["boucherie", "charcuterie_traiteur"])
def test_sql_final_review_persists_the_authoritative_ingestion_profile(
    engine,
    trade_code: str,
) -> None:
    ingestion_id = str(uuid.uuid4())
    run_id = str(uuid.uuid4())
    actor_id = str(uuid.uuid4())
    correlation_id = f"review-profile-{uuid.uuid4()}"
    with engine.begin() as conn:
        organization_id = str(
            conn.execute(
                text("SELECT id FROM identity.organization WHERE slug = 'labelscan'")
            ).scalar_one()
        )
        set_audit_context(
            conn,
            actor_id=actor_id,
            action="ingestion.profile_review_seeded",
            correlation_id=correlation_id,
            trace_id=correlation_id,
        )
        conn.execute(
            text(
                "INSERT INTO ingestion.ingestion ("
                "id, organization_id, status, image_ref, checksum_sha256, "
                "trade_code_snapshot, trade_profile_version, correlation_id, trace_id"
                ") VALUES ("
                ":id, :organization_id, 'needs_review', 'sha256://profile', "
                ":checksum, :trade_code, '2', :correlation_id, :correlation_id)"
            ),
            {
                "id": ingestion_id,
                "organization_id": organization_id,
                "checksum": uuid.uuid4().hex.ljust(64, "0"),
                "trade_code": trade_code,
                "correlation_id": correlation_id,
            },
        )
        conn.execute(
            text(
                "INSERT INTO ingestion.extraction_run ("
                "id, ingestion_id, attempt_no, outcome, extractor_version, "
                "prompt_version, ocr_provider, llm_model, rule_set_version, "
                "correlation_id, trace_id"
                ") VALUES ("
                ":id, :ingestion_id, 1, 'needs_review', 'test', 'test', "
                "'test', 'test', 'test', :correlation_id, :correlation_id)"
            ),
            {
                "id": run_id,
                "ingestion_id": ingestion_id,
                "correlation_id": correlation_id,
            },
        )
        conn.execute(
            text(
                "INSERT INTO ingestion.raw_artifact ("
                "organization_id, ingestion_id, artifact_kind, storage_ref, "
                "checksum_sha256, correlation_id, trace_id"
                ") VALUES ("
                ":organization_id, :ingestion_id, 'image', 'sha256://profile', "
                ":checksum, :correlation_id, :correlation_id)"
            ),
            {
                "organization_id": organization_id,
                "ingestion_id": ingestion_id,
                "checksum": uuid.uuid4().hex.ljust(64, "0"),
                "correlation_id": correlation_id,
            },
        )

    fields = {name: "NC" for name in trade_profile(trade_code).fields}
    result = FinalizeReview(SqlReviewRepository(engine))(
        FinalizeReviewCommand(
            ingestion_id=ingestion_id,
            organization_id=organization_id,
            fields=fields,
            idempotency_key=f"profile-{uuid.uuid4()}",
            actor_id=actor_id,
            correlation_id=correlation_id,
            trace_id=correlation_id,
        )
    )
    with engine.connect() as conn:
        stored = set(
            conn.execute(
                text(
                    "SELECT field_name FROM ingestion.extracted_field "
                    "WHERE extraction_run_id = :run_id"
                ),
                {"run_id": result.run_id},
            ).scalars()
        )
    assert stored == set(fields)
