"""Measure the static system-prefix token length (Work Item B, Decision 1).

Haiku 4.5 caches only a prefix of >=4096 tokens; a shorter prefix silently never
caches (no error, just cache_creation_input_tokens=0). Run this before relying on
prompt caching. Uses the Anthropic count_tokens endpoint (free, model-specific) —
never a local char/word heuristic, which is unreliable near the 4096 floor.

Usage (from repo root, image already built):
    docker run --rm --env-file server/.env \
      -e LABELSCAN_LLM_MODEL=claude-haiku-4-5 \
      -v "$PWD/server/src:/app/src" -v "$PWD/server/scripts:/app/scripts" \
      --entrypoint python labelscan-server:latest /app/scripts/measure_prompt_tokens.py
"""

from __future__ import annotations

import os

import anthropic

from labelscan.contexts.ingestion.adapters.claude_llm_provider import _SYSTEM_TEXT

MODEL = os.environ.get("LABELSCAN_LLM_MODEL", "claude-haiku-4-5")
FLOOR = 4096  # Haiku 4.5 minimum cacheable prefix


def main() -> int:
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
    print(f"static prefix chars = {len(_SYSTEM_TEXT)}")
    print(f"count_tokens(system + 1-char user) input_tokens = {total}")
    cleared = total >= FLOOR
    print(f">=4096 floor cleared: {cleared}  (margin {total - FLOOR:+d} tokens)")
    return 0 if cleared else 1


if __name__ == "__main__":
    raise SystemExit(main())
