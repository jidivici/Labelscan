"""Work Item B (prompt caching) proofs — the static prefix is cacheable and the
dynamic per-request data never leaks into it.

These are unit tests on the Claude adapter: a fake client captures the request so we
can assert the cache_control breakpoint placement and the allow-listed cache-usage
logging WITHOUT network or spend. The model-specific tests that need the real
`count_tokens` endpoint are skipped unless ANTHROPIC_API_KEY is set.
"""

from __future__ import annotations

import json
import os
import re

import pytest

from labelscan.business_profiles import trade_profile
from labelscan.contexts.ingestion.adapters import claude_llm_provider as clp
from labelscan.contexts.ingestion.adapters.claude_llm_provider import (
    _PROMPT_VERSION,
    _SYSTEM_TEXT,
    ClaudeLlmExtractor,
    _output_schema,
    _schema_hash,
    _user_prompt,
    _validated_fields,
)
from labelscan.contexts.ingestion.application.extraction_ports import (
    PermanentProviderError,
    RetryableProviderOutputError,
)
from tests.conftest import capture_logger

# A runtime OCR string with a UNIQUE marker that cannot occur in the static few-shot
# examples — so "marker not in the cached prefix" actually proves no dynamic leak.
_RUNTIME_OCR = "ZZ_RUNTIME_MARKER_42 Smoked Trout batch QX-999 Origin Atlantis"


# ----- fake Anthropic client (records the request, returns a canned response) ----


class _FakeUsage:
    def __init__(
        self, creation: int, read: int, input_tokens: int, output_tokens: int
    ) -> None:
        self.cache_creation_input_tokens = creation
        self.cache_read_input_tokens = read
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _FakeBlock:
    type = "text"

    def __init__(self, text: str) -> None:
        self.text = text


class _FakeResponse:
    def __init__(
        self,
        text: str,
        creation: int,
        read: int,
        input_tokens: int,
        output_tokens: int,
        stop_reason: str,
    ) -> None:
        self.content = [_FakeBlock(text)]
        self.stop_reason = stop_reason
        self.usage = _FakeUsage(creation, read, input_tokens, output_tokens)


class _FakeMessages:
    def __init__(self, parent: "FakeAnthropic") -> None:
        self._p = parent

    def create(self, **kwargs):
        self._p.last_kwargs = kwargs
        if self._p.error is not None:
            raise self._p.error
        return _FakeResponse(
            self._p.reply_text,
            self._p.creation,
            self._p.read,
            self._p.input_tokens,
            self._p.output_tokens,
            self._p.stop_reason,
        )

    def count_tokens(self, **_kwargs):
        if self._p.count_tokens_error is not None:
            raise self._p.count_tokens_error
        return type("TokenCount", (), {"input_tokens": self._p.prefix_tokens})()


class FakeAnthropic:
    """Minimal stand-in for anthropic.Anthropic — supports
    `.with_options(...).messages.create(**kwargs)` and records the last request."""

    def __init__(
        self,
        reply_text: str,
        *,
        creation: int = 0,
        read: int = 0,
        input_tokens: int = 6000,
        output_tokens: int = 500,
        stop_reason: str = "end_turn",
        error: Exception | None = None,
        prefix_tokens: int = 6000,
        count_tokens_error: Exception | None = None,
    ) -> None:
        self.reply_text = reply_text
        self.creation = creation
        self.read = read
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.stop_reason = stop_reason
        self.error = error
        self.prefix_tokens = prefix_tokens
        self.count_tokens_error = count_tokens_error
        self.last_kwargs: dict | None = None
        self.messages = _FakeMessages(self)

    def with_options(self, **_kw):  # timeout is ignored by the fake
        return self


_REPLY = json.dumps(
    {
        "fields": [
            {
                "name": name,
                "value": "Gadus morhua" if name == "scientific_name" else None,
                "confidence": 0.9 if name == "scientific_name" else 0.0,
                "evidence": ["Gadus morhua"] if name == "scientific_name" else [],
                "validation_status": (
                    "present" if name == "scientific_name" else "missing"
                ),
                "warnings": [],
            }
            for name in trade_profile("poissonnerie").fields
        ]
    }
)


def _extractor(client):
    # haiku => no effort/thinking kwargs, keeping the captured request minimal.
    return ClaudeLlmExtractor(client=client, model="claude-haiku-4-5")


# ----- the cached prefix excludes dynamic per-request data + secrets ------------


def test_cached_prefix_excludes_dynamic_and_secrets():
    # the runtime OCR text and the GS1 hint live in the dynamic user message...
    known = ("expiry_date", "batch_number")
    user = _user_prompt(_RUNTIME_OCR, known)
    assert _RUNTIME_OCR in user
    assert "batch_number" in user  # the per-label GS1 hint is in the dynamic message

    # ...and NONE of them appear in the static, cacheable system prefix.
    assert _RUNTIME_OCR not in _SYSTEM_TEXT
    assert "ZZ_RUNTIME_MARKER_42" not in _SYSTEM_TEXT
    # request-identity fields must never sit in the cached prefix.
    assert "correlation_id" not in _SYSTEM_TEXT
    assert "trace_id" not in _SYSTEM_TEXT
    # no wall-clock timestamp leaked (a HH:MM:SS would mean a per-request clock value).
    assert re.search(r"\d{2}:\d{2}:\d{2}", _SYSTEM_TEXT) is None
    assert _PROMPT_VERSION == "seafood-label-extraction/v3.3.0"
    assert re.search(r'"evidence"(?:\s+|:\s*)null', _SYSTEM_TEXT) is None
    assert '"evidence":[]' in _SYSTEM_TEXT


def test_all_prompt_examples_obey_the_closed_field_contract():
    profile = trade_profile("poissonnerie")
    examples = _SYSTEM_TEXT.split("EXPECTED JSON:")[1:]
    assert len(examples) == 4

    for example in examples:
        encoded = example.split("\n(Note:", 1)[0]
        encoded = encoded.split("\n\nEXAMPLE ", 1)[0]
        encoded = encoded.split("\n\nReturn only", 1)[0].strip()
        decoded = json.loads(encoded)
        fields = _validated_fields(decoded, profile)
        assert len(fields) <= len(profile.fields)
        assert all(field["validation_status"] != "missing" for field in fields)


def test_user_prompt_carries_ocr_without_hint_when_no_gs1():
    user = _user_prompt(_RUNTIME_OCR, ())
    assert _RUNTIME_OCR in user
    assert "second coverage audit" in user
    assert "</OCR_TEXT>" in user
    assert "already identified" not in user  # no GS1 hint block when nothing is known


# ----- cache_control breakpoint placement + allow-listed usage logging ----------


def test_cache_enabled_sets_breakpoint_and_logs_usage(monkeypatch, caplog):
    monkeypatch.setattr(clp, "_PROMPT_CACHE_ENABLED", True)
    monkeypatch.setattr(clp, "_PROMPT_CACHE_TTL", "1h")
    monkeypatch.setattr(clp, "_PROMPT_CACHE_1H_VERIFIED", True)
    fake = FakeAnthropic(_REPLY, creation=512, read=0)

    with capture_logger(caplog, "labelscan.ingestion.llm"):
        _extractor(fake).run(_RUNTIME_OCR, ())

    system = fake.last_kwargs["system"]
    assert isinstance(system, list) and len(system) == 1
    # exactly one cache_control breakpoint, at the end of the static system block.
    assert system[0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    assert system[0]["text"] == _SYSTEM_TEXT
    # the dynamic OCR text is in messages, NOT in the cached system block.
    assert _RUNTIME_OCR not in system[0]["text"]

    rec = next(r for r in caplog.records if r.getMessage() == "llm_cache_usage")
    assert rec.cache_creation_input_tokens == 512
    assert rec.cache_read_input_tokens == 0
    assert rec.model == "claude-haiku-4-5"
    assert rec.prompt_version == _PROMPT_VERSION
    assert rec.schema_hash == _schema_hash(
        _output_schema(tuple(trade_profile("poissonnerie").fields))
    )
    assert re.fullmatch(r"[0-9a-f]{64}", rec.cache_identity)
    assert rec.cache_enabled is True
    assert rec.cache_ttl == "1h"
    assert rec.cache_reason == "eligible"
    assert rec.cache_prefix_tokens == 6000
    assert rec.cache_min_tokens == 4096
    assert rec.estimated_cost_usd > 0
    assert rec.latency_ms >= 0
    assert rec.input_tokens == 6000
    assert rec.output_tokens == 500
    assert rec.stop_reason == "end_turn"


def test_cache_disabled_sends_no_cache_control(monkeypatch):
    monkeypatch.setattr(clp, "_PROMPT_CACHE_ENABLED", False)
    fake = FakeAnthropic(_REPLY)

    _extractor(fake).run(_RUNTIME_OCR, ())

    system = fake.last_kwargs["system"]
    assert "cache_control" not in system[0]  # flag off => plain static prefix


def test_cache_is_disabled_when_measured_prefix_is_below_model_floor(
    monkeypatch, caplog
):
    monkeypatch.setattr(clp, "_PROMPT_CACHE_ENABLED", True)
    fake = FakeAnthropic(_REPLY, prefix_tokens=4096)

    with capture_logger(caplog, "labelscan.ingestion.llm"):
        _extractor(fake).run(_RUNTIME_OCR, ())

    assert "cache_control" not in fake.last_kwargs["system"][0]
    rec = next(r for r in caplog.records if r.getMessage() == "llm_cache_usage")
    assert rec.cache_reason == "below_model_floor"
    assert rec.cache_prefix_tokens == 4096


def test_one_hour_cache_requires_separate_measurement_opt_in(monkeypatch, caplog):
    monkeypatch.setattr(clp, "_PROMPT_CACHE_ENABLED", True)
    monkeypatch.setattr(clp, "_PROMPT_CACHE_TTL", "1h")
    monkeypatch.setattr(clp, "_PROMPT_CACHE_1H_VERIFIED", False)
    fake = FakeAnthropic(_REPLY)

    with capture_logger(caplog, "labelscan.ingestion.llm"):
        _extractor(fake).run(_RUNTIME_OCR, ())

    assert "cache_control" not in fake.last_kwargs["system"][0]
    rec = next(r for r in caplog.records if r.getMessage() == "llm_cache_usage")
    assert rec.cache_reason == "one_hour_not_verified"


def test_historical_compact_profile_is_not_marked_cacheable(monkeypatch):
    monkeypatch.setattr(clp, "_PROMPT_CACHE_ENABLED", True)
    fake = FakeAnthropic(
        json.dumps(
            {
                "fields": [
                    {
                        "name": name,
                        "value": None,
                        "confidence": 0,
                        "evidence": [],
                        "validation_status": "missing",
                        "warnings": [],
                    }
                    for name in trade_profile("poissonnerie", "1").fields
                ]
            }
        )
    )
    _extractor(fake).run(
        _RUNTIME_OCR,
        (),
        trade_code="poissonnerie",
        trade_profile_version="1",
    )
    assert "cache_control" not in fake.last_kwargs["system"][0]


def test_two_calls_report_cache_creation_then_cache_read(monkeypatch, caplog):
    # Simulate the two provider responses of a cold then warm call on the same
    # extractor. The paid provider probe below remains the end-to-end proof.
    monkeypatch.setattr(clp, "_PROMPT_CACHE_ENABLED", True)
    monkeypatch.setenv("LABELSCAN_ANTHROPIC_RPS", "10")
    fake = FakeAnthropic(_REPLY, creation=4096, read=0)
    extractor = _extractor(fake)

    with capture_logger(caplog, "labelscan.ingestion.llm"):
        extractor.run(_RUNTIME_OCR, ())
        fake.creation = 0
        fake.read = 4096
        extractor.run(_RUNTIME_OCR, ())

    records = [r for r in caplog.records if r.getMessage() == "llm_cache_usage"]
    # `capture_logger` may surface the same record through both the named logger
    # and its configured parent; the chronological endpoints remain unambiguous.
    assert records[0].cache_creation_input_tokens == 4096
    assert records[0].cache_read_input_tokens == 0
    assert records[-1].cache_creation_input_tokens == 0
    assert records[-1].cache_read_input_tokens == 4096


def test_opus_4_8_uses_registry_capabilities():
    fake = FakeAnthropic(_REPLY)
    ClaudeLlmExtractor(client=fake, model="claude-opus-4-8").run(_RUNTIME_OCR)
    assert fake.last_kwargs["max_tokens"] == 8192
    assert fake.last_kwargs["thinking"] == {"type": "adaptive"}
    assert fake.last_kwargs["output_config"]["effort"] == "high"


def test_unknown_model_fails_before_provider_call():
    fake = FakeAnthropic(_REPLY)
    with pytest.raises(ValueError, match="unsupported Anthropic model"):
        ClaudeLlmExtractor(client=fake, model="claude-sonnet-4-5")
    assert fake.last_kwargs is None


class _HttpError(RuntimeError):
    def __init__(self, status_code: int) -> None:
        super().__init__("provider detail must not be logged")
        self.status_code = status_code


def test_permanent_http_error_is_classified_without_response_data():
    fake = FakeAnthropic(_REPLY, error=_HttpError(400))
    with pytest.raises(PermanentProviderError, match="HTTP 400") as caught:
        _extractor(fake).run(_RUNTIME_OCR)
    assert "provider detail" not in str(caught.value)


def test_retryable_http_error_is_preserved_for_consumer_retry():
    error = _HttpError(429)
    fake = FakeAnthropic(_REPLY, error=error)
    with pytest.raises(_HttpError) as caught:
        _extractor(fake).run(_RUNTIME_OCR)
    assert caught.value is error


def test_incomplete_stop_reason_can_be_regenerated():
    fake = FakeAnthropic(_REPLY, stop_reason="max_tokens")
    with pytest.raises(RetryableProviderOutputError, match="max_tokens"):
        _extractor(fake).run(_RUNTIME_OCR)


def test_local_contract_enforces_bounds_and_absent_invariants():
    profile = trade_profile("poissonnerie")
    valid = json.loads(_REPLY)
    assert len(_validated_fields(valid, profile)) == len(profile.fields)

    invalid = json.loads(_REPLY)
    invalid["fields"][0]["value"] = None
    invalid["fields"][0]["confidence"] = 0.2
    with pytest.raises(RetryableProviderOutputError, match="absent-value"):
        _validated_fields(invalid, profile)

    invalid = json.loads(_REPLY)
    invalid["fields"][1]["evidence"] = ["x"] * 17
    with pytest.raises(RetryableProviderOutputError, match="evidence"):
        _validated_fields(invalid, profile)

    invalid = json.loads(_REPLY)
    scientific = next(
        field for field in invalid["fields"] if field["name"] == "scientific_name"
    )
    scientific["evidence"] = ["   "]
    with pytest.raises(RetryableProviderOutputError, match="evidence"):
        _validated_fields(invalid, profile)

    invalid = json.loads(_REPLY)
    expiry = next(
        field for field in invalid["fields"] if field["name"] == "expiry_date"
    )
    expiry.update(
        value="2026-08",
        confidence=0.9,
        evidence=["2026-08"],
        validation_status="normalized",
    )
    with pytest.raises(RetryableProviderOutputError, match="non-canonical"):
        _validated_fields(invalid, profile)

    invalid = json.loads(_REPLY)
    scientific = next(
        field for field in invalid["fields"] if field["name"] == "scientific_name"
    )
    scientific.update(
        value="NC",
        confidence=0.9,
        evidence=["NC"],
        validation_status="present",
    )
    with pytest.raises(RetryableProviderOutputError, match="non-canonical"):
        _validated_fields(invalid, profile)


def test_sparse_contract_accepts_subset_and_defaults_optional_diagnostics():
    profile = trade_profile("poissonnerie")
    sparse = {
        "fields": [
            {
                "name": "scientific_name",
                "value": "Gadus morhua",
                "confidence": 0.9,
                "evidence": ["Gadus morhua"],
            },
            {
                "name": "FAO_area",
                "value": None,
                "confidence": 0.0,
                "evidence": [],
                "validation_status": "ambiguous",
                "warnings": ["Sea named without an FAO designation."],
            },
        ]
    }
    fields = _validated_fields(sparse, profile)
    assert fields[0]["validation_status"] == "present"
    assert fields[0]["warnings"] == []
    assert fields[1]["validation_status"] == "ambiguous"


# ----- the static prefix clears each allow-listed model's cache floor ------------


@pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="needs ANTHROPIC_API_KEY (count_tokens is a billed API call)",
)
@pytest.mark.parametrize(
    ("model", "floor"),
    [("claude-haiku-4-5", 4096), ("claude-opus-4-8", 1024)],
)
def test_static_prefix_meets_model_cache_floor(model: str, floor: int):
    anthropic = pytest.importorskip("anthropic")
    client = anthropic.Anthropic()
    resp = client.messages.count_tokens(
        model=model,
        system=[{"type": "text", "text": _SYSTEM_TEXT}],
        messages=[{"role": "user", "content": "x"}],
    )
    assert resp.input_tokens >= floor, resp.input_tokens
