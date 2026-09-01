"""Measure the model-specific static system-prefix cache eligibility.

Run this before relying on prompt caching. Uses Anthropic's model-specific
`count_tokens` endpoint rather than a local character/word heuristic.

Usage (from repo root, image already built):
    docker run --rm --env-file server/.env \
      -e LABELSCAN_LLM_MODEL=claude-haiku-4-5 \
      -v "$PWD/server/src:/app/src" -v "$PWD/server/scripts:/app/scripts" \
      --entrypoint python labelscan-server:latest /app/scripts/measure_prompt_tokens.py
"""

from __future__ import annotations

import os

import anthropic

from labelscan.contexts.ingestion.adapters.anthropic_models import anthropic_model
from labelscan.contexts.ingestion.adapters.claude_llm_provider import (
    _OUTPUT_SCHEMA,
    _PROMPT_VERSION,
    _SYSTEM_TEXT,
    _schema_hash,
)

MODEL = os.environ.get("LABELSCAN_LLM_MODEL", "claude-haiku-4-5").strip()


def main() -> int:
    model = anthropic_model(MODEL)
    client = anthropic.Anthropic()
    # The cache_control breakpoint sits on the system block (no tools), so the
    # cacheable prefix is the system block. A 1-char user turn isolates it (~3 tokens
    # of envelope); the system block dominates.
    resp = client.messages.count_tokens(
        model=MODEL,
        system=[{"type": "text", "text": _SYSTEM_TEXT}],
        messages=[{"role": "user", "content": "x"}],
    )
    total = resp.input_tokens
    print(f"model = {MODEL}")
    print(f"prompt version = {_PROMPT_VERSION}")
    print(f"schema sha256 = {_schema_hash(_OUTPUT_SCHEMA)}")
    print(f"static prefix chars = {len(_SYSTEM_TEXT)}")
    print(f"count_tokens(system + 1-char user) input_tokens = {total}")
    # Match the runtime's conservative one-character-envelope margin.
    safety_margin = 32
    cleared = total >= model.cache_min_tokens + safety_margin
    print(
        f">={model.cache_min_tokens} floor + {safety_margin} safety tokens cleared: "
        f"{cleared}  (margin {total - model.cache_min_tokens:+d} tokens)"
    )
    return 0 if cleared else 1


if __name__ == "__main__":
    raise SystemExit(main())
