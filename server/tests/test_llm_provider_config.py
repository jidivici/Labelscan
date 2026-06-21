"""Unit tests for the configurable LLM model name. Importing the provider module
does NOT import the anthropic SDK (that happens lazily in __init__), so these run
without the SDK, network, or a DB."""

from __future__ import annotations

import importlib

import labelscan.contexts.ingestion.adapters.claude_llm_provider as prov


def test_model_defaults_to_haiku_4_5(monkeypatch):
    # Hybrid pipeline default: GS1 handles exact fields, the LLM only free text →
    # the cheaper/faster Haiku is the default (re-calibrate thresholds when changing).
    monkeypatch.delenv("LABELSCAN_LLM_MODEL", raising=False)
    importlib.reload(prov)
    assert prov._MODEL == "claude-haiku-4-5"


def test_model_overridable_via_env(monkeypatch):
    monkeypatch.setenv("LABELSCAN_LLM_MODEL", "claude-sonnet-4-6")
    importlib.reload(prov)
    try:
        assert prov._MODEL == "claude-sonnet-4-6"
    finally:
        # Restore module-level state so later tests see the default.
        monkeypatch.delenv("LABELSCAN_LLM_MODEL", raising=False)
        importlib.reload(prov)


def test_request_timeout_is_bounded():
    # A finite, positive per-request timeout (not the SDK's 600s default).
    assert 0 < prov._REQUEST_TIMEOUT_S < 600
