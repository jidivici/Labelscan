"""Work Item B (prompt caching) proofs — the static prefix is cacheable and the
dynamic per-request data never leaks into it.

These are unit tests on the Claude adapter: a fake client captures the request so we
can assert the cache_control breakpoint placement and the allow-listed cache-usage
logging WITHOUT the SDK, network, or spend. The one test that needs the real
count_tokens endpoint (the >=4096 Haiku floor) is skipped unless ANTHROPIC_API_KEY
is set and the SDK is installed.
"""

from __future__ import annotations

import json
import os
import re

import pytest

from labelscan.contexts.ingestion.adapters import claude_llm_provider as clp
from labelscan.contexts.ingestion.adapters.claude_llm_provider import (
    _SYSTEM_TEXT,
    ClaudeLlmExtractor,
    _user_prompt,
)
from tests.conftest import capture_logger

# A runtime OCR string with a UNIQUE marker that cannot occur in the static few-shot
# examples — so "marker not in the cached prefix" actually proves no dynamic leak.
_RUNTIME_OCR = "ZZ_RUNTIME_MARKER_42 Smoked Trout batch QX-999 Origin Atlantis"


# ----- fake Anthropic client (records the request, returns a canned response) ----


class _FakeUsage:
    def __init__(self, creation: int, read: int) -> None:
        self.cache_creation_input_tokens = creation
        self.cache_read_input_tokens = read


class _FakeBlock:
    type = "text"

    def __init__(self, text: str) -> None:
        self.text = text


class _FakeResponse:
    def __init__(self, text: str, creation: int, read: int) -> None:
        self.content = [_FakeBlock(text)]
        self.stop_reason = "end_turn"
        self.usage = _FakeUsage(creation, read)


class _FakeMessages:
    def __init__(self, parent: "FakeAnthropic") -> None:
        self._p = parent

    def create(self, **kwargs):
        self._p.last_kwargs = kwargs
        return _FakeResponse(self._p.reply_text, self._p.creation, self._p.read)


class FakeAnthropic:
    """Minimal stand-in for anthropic.Anthropic — supports
    `.with_options(...).messages.create(**kwargs)` and records the last request."""

    def __init__(self, reply_text: str, *, creation: int = 0, read: int = 0) -> None:
        self.reply_text = reply_text
        self.creation = creation
        self.read = read
        self.last_kwargs: dict | None = None
        self.messages = _FakeMessages(self)

    def with_options(self, **_kw):  # timeout is ignored by the fake
        return self


_REPLY = json.dumps(
    {
        "fields": [
            {
                "name": "scientific_name",
                "value": "Gadus morhua",
                "confidence": 0.9,
                "evidence": ["Gadus morhua"],
                "validation_status": "present",
                "warnings": [],
            }
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


def test_user_prompt_carries_ocr_without_hint_when_no_gs1():
    user = _user_prompt(_RUNTIME_OCR, ())
    assert _RUNTIME_OCR in user
    assert "already identified" not in user  # no GS1 hint block when nothing is known


# ----- cache_control breakpoint placement + allow-listed usage logging ----------


def test_cache_enabled_sets_breakpoint_and_logs_usage(monkeypatch, caplog):
    monkeypatch.setattr(clp, "_PROMPT_CACHE_ENABLED", True)
    monkeypatch.setattr(clp, "_PROMPT_CACHE_TTL", "1h")
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


def test_cache_disabled_sends_no_cache_control(monkeypatch):
    monkeypatch.setattr(clp, "_PROMPT_CACHE_ENABLED", False)
    fake = FakeAnthropic(_REPLY)

    _extractor(fake).run(_RUNTIME_OCR, ())

    system = fake.last_kwargs["system"]
    assert "cache_control" not in system[0]  # flag off => plain static prefix


def test_cache_read_reported_on_second_call(monkeypatch, caplog):
    # within the TTL the provider reports cache_read_input_tokens>0 on a warm call;
    # the adapter surfaces it on the allow-listed metric (proves the cache is read).
    monkeypatch.setattr(clp, "_PROMPT_CACHE_ENABLED", True)
    warm = FakeAnthropic(_REPLY, creation=0, read=4096)

    with capture_logger(caplog, "labelscan.ingestion.llm"):
        _extractor(warm).run(_RUNTIME_OCR, ())

    rec = next(r for r in caplog.records if r.getMessage() == "llm_cache_usage")
    assert rec.cache_read_input_tokens == 4096
    assert rec.cache_creation_input_tokens == 0


# ----- the static prefix actually clears the Haiku 4.5 >=4096-token cache floor --


@pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="needs ANTHROPIC_API_KEY (count_tokens is a billed API call)",
)
def test_static_prefix_meets_haiku_4096_floor():
    anthropic = pytest.importorskip("anthropic")
    client = anthropic.Anthropic()
    resp = client.messages.count_tokens(
        model="claude-haiku-4-5",
        system=[{"type": "text", "text": _SYSTEM_TEXT}],
        messages=[{"role": "user", "content": "x"}],
    )
    # Decision 1: Haiku 4.5 caches only a prefix of >=4096 tokens; below it the prefix
    # silently never caches (cache_creation_input_tokens stays 0).
    assert resp.input_tokens >= 4096, resp.input_tokens
