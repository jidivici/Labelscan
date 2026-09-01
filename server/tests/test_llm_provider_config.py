"""Unit tests for the configurable LLM model name. Importing the provider module
does NOT import the anthropic SDK (that happens lazily in __init__), so these run
without the SDK, network, or a DB."""

from __future__ import annotations

import importlib

import pytest

import labelscan.contexts.ingestion.adapters.claude_llm_provider as prov
from labelscan.contexts.ingestion.adapters.anthropic_models import anthropic_model


def test_model_defaults_to_haiku_4_5(monkeypatch):
    # Hybrid pipeline default: GS1 handles exact fields, the LLM only free text →
    # the cheaper/faster Haiku is the default (re-calibrate thresholds when changing).
    monkeypatch.delenv("LABELSCAN_LLM_MODEL", raising=False)
    importlib.reload(prov)
    assert prov._MODEL == "claude-haiku-4-5"
    assert prov._PROMPT_CACHE_TTL == "5m"


def test_model_overridable_via_env(monkeypatch):
    monkeypatch.setenv("LABELSCAN_LLM_MODEL", "claude-opus-4-8")
    importlib.reload(prov)
    try:
        assert prov._MODEL == "claude-opus-4-8"
    finally:
        # Restore module-level state so later tests see the default.
        monkeypatch.delenv("LABELSCAN_LLM_MODEL", raising=False)
        importlib.reload(prov)


def test_unknown_model_env_fails_closed(monkeypatch):
    monkeypatch.setenv("LABELSCAN_LLM_MODEL", "claude-sonnet-4-6")
    with pytest.raises(ValueError, match="unsupported Anthropic model"):
        importlib.reload(prov)
    monkeypatch.delenv("LABELSCAN_LLM_MODEL", raising=False)
    importlib.reload(prov)


def test_invalid_prompt_cache_ttl_fails_closed(monkeypatch):
    monkeypatch.setenv("LABELSCAN_LLM_PROMPT_CACHE_TTL", "30m")
    with pytest.raises(ValueError, match="must be '5m' or '1h'"):
        importlib.reload(prov)
    monkeypatch.delenv("LABELSCAN_LLM_PROMPT_CACHE_TTL", raising=False)
    importlib.reload(prov)


def test_model_registry_contains_only_evaluated_capabilities():
    haiku = anthropic_model("claude-haiku-4-5")
    assert (haiku.cache_min_tokens, haiku.adaptive_thinking, haiku.effort) == (
        4096,
        False,
        None,
    )
    opus = anthropic_model("claude-opus-4-8")
    assert (opus.cache_min_tokens, opus.adaptive_thinking, opus.effort) == (
        1024,
        True,
        "high",
    )
    assert (
        haiku.estimated_cost_usd(
            input_tokens=1000,
            output_tokens=100,
            cache_creation_tokens=0,
            cache_read_tokens=0,
            cache_ttl="5m",
        )
        == 0.0015
    )


def test_request_timeout_is_bounded():
    # A finite, positive per-request timeout (not the SDK's 600s default).
    assert 0 < prov._REQUEST_TIMEOUT_S < 600
