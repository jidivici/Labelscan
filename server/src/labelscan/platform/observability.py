"""Structured JSON logging (platform / infrastructure) — minimal observability.

Dependency-free: stdlib `logging` + a JSON formatter that always surfaces the
`correlation_id`/`trace_id` already propagated end-to-end. One line per event on
stdout (12-factor) — diagnosable 500s, provider failures and worker dispatch
without any new infrastructure.

Discipline:
  * SERVER-SIDE ONLY — this never changes the problem+json response sent to clients
    (which stays sanitized). Logging the real exception here is the whole point.
  * NEVER log secrets, image bytes, OCR/LLM raw bodies or request payloads — only
    identifiers (correlation/trace/ingestion ids), the error code and the outcome.
  * Pure infra: no domain import; safe to import from platform/app/adapters.
"""

from __future__ import annotations

import json
import logging
import os
import sys

_ROOT = "labelscan"
_CONFIGURED = False

# Stable, allow-listed structured fields attached via `extra={...}`. Anything not
# listed is ignored, so a stray `extra` can never leak an unexpected value.
_EXTRA_FIELDS = (
    "correlation_id",
    "trace_id",
    "event_type",
    "consumer",
    "ingestion_id",
    "run_id",
    "outcome",
    "error_code",
    "status",
    "path",
    "error",
    # extraction model + prompt-cache + escalation metrics: token counts and a model
    # id / reason enum only — NEVER prompt contents, OCR text, or secrets.
    "model",
    "reason",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    # latency instrumentation (docs/LATENCY-REVIEW.md §6): per-ingestion OCR/LLM durations
    # and the provider retry count — scalars only, never payloads. Without these allow-listed
    # the `extraction_timing` event logs but DROPS its numbers (the split stays invisible).
    "ocr_ms",
    "llm_ms",
    "attempts",
    "image_bytes",
    # Tier 3 wave 2: how many deterministic preview fields the interim commit wrote
    # (a count only — never the values).
    "interim_field_count",
)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key in _EXTRA_FIELDS:
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        if record.exc_info and record.exc_info[0] is not None:
            payload["exc_type"] = record.exc_info[0].__name__
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging() -> None:
    """Idempotently route the `labelscan.*` loggers to stdout as JSON.

    Level from `LABELSCAN_LOG_LEVEL` (default INFO). Safe to call from every
    entrypoint (HTTP app factory, worker runtime); only the first call takes effect.
    """
    global _CONFIGURED
    if _CONFIGURED:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger(_ROOT)
    root.handlers[:] = [handler]
    root.setLevel(os.environ.get("LABELSCAN_LOG_LEVEL", "INFO").upper())
    root.propagate = False  # don't double-log through the python root logger
    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """A namespaced `labelscan.<name>` logger. Use `extra={...}` for structured fields."""
    return logging.getLogger(f"{_ROOT}.{name}")
