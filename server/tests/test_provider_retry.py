"""Unit tests for ExtractionConsumer._with_provider_retry. No DB required —
the consumer is constructed with placeholder deps and we drive the retry helper
directly with synthetic callables."""

from __future__ import annotations

import pytest

from labelscan.contexts.ingestion.adapters.extraction_consumer import (
    ExtractionConsumer,
    _ProviderExhausted,
)
from labelscan.contexts.ingestion.application.extraction_ports import (
    PermanentProviderError,
)
from labelscan.contexts.ingestion.domain.extraction import RuleSet

RULES = RuleSet(version="unit", required_fields=frozenset())


def _consumer(max_attempts=3) -> ExtractionConsumer:
    # _with_provider_retry touches none of these deps; it only calls the passed fn.
    return ExtractionConsumer(
        engine=None,
        raw_store=None,
        ocr=None,
        llm=None,
        rule_set=RULES,
        max_provider_attempts=max_attempts,
    )


def test_success_returns_value_without_retry():
    calls = {"n": 0}

    def ok():
        calls["n"] += 1
        return "result"

    assert _consumer()._with_provider_retry(ok) == "result"
    assert calls["n"] == 1


def test_unknown_runtime_error_is_not_retried():
    calls = {"n": 0}

    def transient():
        calls["n"] += 1
        raise RuntimeError("provider unavailable")

    with pytest.raises(_ProviderExhausted):
        _consumer(max_attempts=3)._with_provider_retry(transient)
    assert calls["n"] == 1


class _HttpError(RuntimeError):
    def __init__(self, status_code: int, retry_after: str | None = None) -> None:
        super().__init__("provider response body must stay private")
        self.status_code = status_code
        self.response = type(
            "Response",
            (),
            {"headers": {"Retry-After": retry_after} if retry_after else {}},
        )()


@pytest.mark.parametrize("status", [408, 409, 429, 500, 503])
def test_only_retryable_http_statuses_are_retried(status, monkeypatch):
    calls = {"n": 0}
    sleeps: list[float] = []
    monkeypatch.setattr(
        "labelscan.contexts.ingestion.adapters.extraction_consumer.random.uniform",
        lambda *_: 1.0,
    )
    monkeypatch.setattr(
        "labelscan.contexts.ingestion.adapters.extraction_consumer.time.sleep",
        sleeps.append,
    )

    def transient():
        calls["n"] += 1
        raise _HttpError(status)

    with pytest.raises(_ProviderExhausted, match=f"HTTP {status}") as caught:
        _consumer(max_attempts=3)._with_provider_retry(transient)
    assert calls["n"] == 3
    assert sleeps == [0.25, 0.5]
    assert "response body" not in str(caught.value)


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
def test_permanent_http_status_is_not_retried(status):
    calls = {"n": 0}

    def rejected():
        calls["n"] += 1
        raise _HttpError(status)

    with pytest.raises(_ProviderExhausted, match=f"HTTP {status}"):
        _consumer(max_attempts=3)._with_provider_retry(rejected)
    assert calls["n"] == 1


def test_retry_after_is_respected(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(
        "labelscan.contexts.ingestion.adapters.extraction_consumer.random.uniform",
        lambda *_: 1.0,
    )
    monkeypatch.setattr(
        "labelscan.contexts.ingestion.adapters.extraction_consumer.time.sleep",
        sleeps.append,
    )

    with pytest.raises(_ProviderExhausted):
        _consumer(max_attempts=2)._with_provider_retry(
            lambda: (_ for _ in ()).throw(_HttpError(429, "3"))
        )
    assert sleeps == [3.0]


def test_invalid_local_json_is_not_retried():
    calls = {"n": 0}

    def invalid():
        calls["n"] += 1
        raise ValueError("sensitive local response")

    with pytest.raises(_ProviderExhausted, match="invalid local provider result"):
        _consumer(max_attempts=3)._with_provider_retry(invalid)
    assert calls["n"] == 1


def test_programming_error_propagates_without_retry():
    # A TypeError is a bug, not a transient failure: it must surface immediately
    # (not be retried, not be swallowed into a FAILED run).
    calls = {"n": 0}

    def bug():
        calls["n"] += 1
        raise TypeError("not subscriptable")

    with pytest.raises(TypeError):
        _consumer(max_attempts=3)._with_provider_retry(bug)
    assert calls["n"] == 1  # no retry on a programming error


def test_permanent_provider_error_fails_after_one_attempt():
    calls = {"n": 0}

    def rejected_request():
        calls["n"] += 1
        raise PermanentProviderError("provider rejected request")

    with pytest.raises(_ProviderExhausted):
        _consumer(max_attempts=3)._with_provider_retry(rejected_request)
    assert calls["n"] == 1
