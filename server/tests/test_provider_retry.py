"""Unit tests for ExtractionConsumer._with_provider_retry. No DB required —
the consumer is constructed with placeholder deps and we drive the retry helper
directly with synthetic callables."""

from __future__ import annotations

import pytest

from labelscan.contexts.ingestion.adapters.extraction_consumer import (
    ExtractionConsumer,
    _ProviderExhausted,
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


def test_transient_error_retried_to_limit_then_exhausted():
    calls = {"n": 0}

    def transient():
        calls["n"] += 1
        raise RuntimeError("provider unavailable")

    with pytest.raises(_ProviderExhausted):
        _consumer(max_attempts=3)._with_provider_retry(transient)
    assert calls["n"] == 3  # retried up to the limit


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
