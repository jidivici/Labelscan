"""FURIC regression: a field defect cannot cancel otherwise usable extraction."""

import json
import uuid
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from labelscan.app.http_app import create_app
from labelscan.business_profiles import trade_profile
from labelscan.contexts.ingestion.adapters.claude_llm_provider import (
    ClaudeLlmExtractor,
    _system_text_for,
    _validated_fields,
)
from labelscan.contexts.ingestion.application.extraction_ports import (
    RetryableProviderOutputError,
)
from labelscan.contexts.ingestion.domain.extraction import (
    MODEL_FIELD_REVIEW_WARNING,
    MODEL_OUTPUT_REVIEW_WARNING,
    LlmField,
    RuleSet,
    evaluate,
)
from labelscan.contexts.ingestion.domain.gs1 import parse_gs1
from labelscan.contexts.ingestion.domain.input_validation import (
    validate_human_field_value,
)
from labelscan.contexts.ingestion.domain.reconciliation import (
    adjusted_outcome,
    reconcile,
)
from labelscan.platform.http.deps import get_engine
from tests._fakes import FakeOcr
from tests._review import finalize_poissonnerie
from tests.conftest import bearer
from tests.test_extraction_consumer import (
    _cmd,
    _consumer,
    _quiesce,
    _runs,
    _worker_with,
)
from tests.test_prompt_cache import FakeAnthropic

OCR = "FILET JULIENNE\nMolva molva\nPêché en FAO 27 IV & autres ss zones\nLot: 65250901247"


def candidate(name, value, **extra):
    return {"name": name, "value": value, "confidence": 0.95, "evidence": [value], **extra}


def good_candidates():
    return [
        candidate("commercial_designation", "FILET JULIENNE"),
        candidate("scientific_name", "Molva molva"),
        candidate("production_method", "wild_caught", evidence=["Pêché en"], validation_status="normalized"),
        candidate("FAO_area", "FAO 27 IV & autres ss zones"),
        candidate("batch_number", "65250901247"),
    ]


def verdict_for(fields, ocr=OCR):
    profile = trade_profile("poissonnerie")
    proposals = tuple(LlmField(
        name=f["name"], value=f["value"], llm_confidence=f["confidence"],
        evidence=tuple(f["evidence"]), validation_status=f["validation_status"],
        warnings=tuple(f["warnings"]),
    ) for f in fields)
    return evaluate(proposals, ocr_text=ocr, ocr_confidence=0.94, rule_set=RuleSet(
        version="trade-profile:poissonnerie:v3",
        required_fields=frozenset(profile.required_fields), allowed_fields=frozenset(profile.fields),
    ))


@pytest.mark.parametrize("area", [
    "FAO 27 IV & autres ss zones", "FAO 27.8.b.1", "FAO: 27 / 37 — sous-zones",
    "Zone de capture: golfe de Gascogne (VIII)",
])
def test_printed_area_preserved_without_geographic_inference(area):
    assert validate_human_field_value("FAO_area", area) == area
    fields = _validated_fields({"fields": [candidate("FAO_area", area)]}, trade_profile("poissonnerie"))
    assert fields[0]["value"] == area


@pytest.mark.parametrize("bad", [
    candidate("packaging_date", "2026-09"),
    candidate("packaging_date", "2026-02-31"),
    candidate("weight", "0 kg"),
    candidate("storage_temperature", "entre frais et froid"),
    candidate("origin_country", "France", evidence=[" "]),
    candidate("producer_name", "a" * 513),
    candidate("producer_name", "ABC\u202eDEF"),
    candidate("producer_name", "ABC", confidence=float("nan")),
    candidate("producer_name", "ABC", confidence=True),
    candidate("producer_name", "NC"),
    {"name": "producer_name", "value": {"unexpected": True}},
])
def test_bad_optional_field_does_not_lose_other_values_or_become_extracted(bad):
    fields = _validated_fields({"fields": [*good_candidates(), bad]}, trade_profile("poissonnerie"))
    by_name = {f["name"]: f for f in fields}
    assert by_name["FAO_area"]["value"] == "FAO 27 IV & autres ss zones"
    assert by_name[bad["name"]]["value"] is None
    assert by_name[bad["name"]]["warnings"] == [MODEL_FIELD_REVIEW_WARNING]
    verdict = verdict_for(fields)
    assert verdict.outcome == "needs_review"
    combined = reconcile(verdict.fields, parse_gs1(None), ocr_artifact_id="ocr", image_artifact_id="image")
    assert adjusted_outcome(verdict, combined) == "needs_review"


def test_safe_typographic_normalization_is_not_a_provider_failure():
    fields = _validated_fields({"fields": [candidate("weight", " 1,25 KG ")]}, trade_profile("poissonnerie"))
    assert fields[0]["value"] == "1.25 kg"
    assert fields[0]["evidence"] == [" 1,25 KG "]
    assert fields[0]["validation_status"] == "normalized"


def test_conflicting_duplicate_is_quarantined_without_losing_other_fields():
    fields = _validated_fields({"fields": [*good_candidates(), candidate("batch_number", "OTHER123")]}, trade_profile("poissonnerie"))
    assert next(f for f in fields if f["name"] == "batch_number")["value"] is None
    assert next(f for f in fields if f["name"] == "FAO_area")["value"] is not None
    assert len({f["name"] for f in fields}) == len(fields)


def test_removed_fields_are_not_reintroduced_into_v3():
    fields = _validated_fields({"fields": [
        *good_candidates(), candidate("gtin", "3201368"), candidate("expiry_date", "2026-09-28"),
    ]}, trade_profile("poissonnerie"))
    assert {f["name"] for f in fields} == {f["name"] for f in good_candidates()}


def test_valid_shapes_still_cross_the_evidence_gate():
    fields = _validated_fields({"fields": [*good_candidates(), candidate("producer_name", "INVENTED")]}, trade_profile("poissonnerie"))
    verdict = verdict_for(fields)
    assert next(f for f in verdict.fields if f.name == "producer_name").value is None
    assert "EVIDENCE_NOT_IN_RAW_OCR" in verdict.security_flags


@pytest.mark.parametrize("payload", [None, {"fields": "bad"}, {"fields": [{}]}, {"fields": [{}] * 65}])
def test_unusable_envelopes_remain_retryable(payload):
    with pytest.raises(RetryableProviderOutputError):
        _validated_fields(payload, trade_profile("poissonnerie"))


def test_prompt_v3_is_self_contained_and_examples_have_exact_evidence():
    profile = trade_profile("poissonnerie")
    prompt = _system_text_for(profile)
    assert "expiry_date" not in prompt and "gtin" not in prompt
    assert "FAO 27 IV & autres ss zones" in prompt
    for example in prompt.split("OCR TEXT:")[1:]:
        ocr, output = example.split("EXPECTED JSON:", 1)
        data, _ = json.JSONDecoder().raw_decode(output.lstrip())
        fields = _validated_fields(data, profile)
        assert all(f["validation_status"] != "invalid" for f in fields)
        assert all(e in ocr for f in fields for e in f["evidence"])


class CountingAnthropic(FakeAnthropic):
    def __init__(self, reply):
        super().__init__(reply)
        self.calls = 0
        create = self.messages.create

        def counted(**kwargs):
            self.calls += 1
            return create(**kwargs)

        self.messages.create = counted


@pytest.mark.parametrize("reply, expected_calls, all_invalid", [
    (json.dumps({"fields": [*good_candidates(), candidate("packaging_date", "2026-09")]}), 1, False),
    (json.dumps({"fields": [candidate("weight", "0 kg")]}), 1, True),
    ("{not valid JSON", 2, True),
])
def test_pipeline_opens_review_and_keeps_image_even_without_valid_model_fields(
    submit, engine, raw_store, monkeypatch, reply, expected_calls, all_invalid,
):
    monkeypatch.setattr("labelscan.contexts.ingestion.adapters.extraction_consumer.time.sleep", lambda _: None)
    monkeypatch.setenv("LABELSCAN_ANTHROPIC_RPS", "1000")
    _quiesce(engine)
    ingestion = submit(replace(_cmd(uuid.uuid4().hex.encode()), trade_profile_version="3"))
    provider = CountingAnthropic(reply)
    ocr = FakeOcr(OCR)
    consumer = _consumer(engine, raw_store, ocr, ClaudeLlmExtractor(client=provider))
    worker = _worker_with(engine, consumer)
    worker.run_once()
    assert provider.calls == expected_calls
    assert _runs(engine, ingestion.ingestion_id)[0]["outcome"] == "needs_review"

    app = create_app()
    app.dependency_overrides[get_engine] = lambda: engine
    with TestClient(app) as client:
        response = client.get(f"/v1/ingestions/{ingestion.ingestion_id}", headers=bearer("ingestion:read"))
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "needs_review"
    assert body["recapture_required"] is False
    assert {a["artifact_kind"] for a in body["raw_artifacts"]} >= {"image", "ocr_json"}
    fields = {f["field_name"]: f for f in body["latest_fields"]}
    if all_invalid:
        assert all(f["value"] is None for f in fields.values())
    else:
        assert fields["FAO_area"]["value"] == "FAO 27 IV & autres ss zones"
        assert fields["packaging_date"]["value"] is None
    if expected_calls == 2:
        assert any(MODEL_OUTPUT_REVIEW_WARNING in f["warnings"] for f in fields.values())
    worker.run_once()
    assert provider.calls == expected_calls
    assert ocr.calls == 1
    assert len(_runs(engine, ingestion.ingestion_id)) == 1

    # The operator can actually complete this run; a 'needs_review' label alone
    # would be insufficient if finalization still rejected the fallback state.
    finalize_poissonnerie(engine, ingestion.ingestion_id)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT status FROM ingestion.ingestion WHERE id=:id"), {"id": ingestion.ingestion_id}).scalar_one() == "confirmed"
