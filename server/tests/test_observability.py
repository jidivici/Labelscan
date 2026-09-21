"""Structured JSON logging — pure, NO DB."""

from __future__ import annotations

import io
import json
import logging

from labelscan.platform.observability import (
    JsonFormatter,
    configure_logging,
    get_logger,
)


def _capture(level: int = logging.INFO):
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(JsonFormatter())
    lg = logging.getLogger("labelscan.test.capture")
    lg.handlers[:] = [handler]
    lg.setLevel(level)
    lg.propagate = False
    return lg, buf


def test_core_and_allowlisted_fields_emitted_secrets_dropped():
    lg, buf = _capture()
    lg.info(
        "event_handled",
        extra={
            "correlation_id": "c1",
            "trace_id": "t1",
            "ingestion_id": "i1",
            "consumer": "extraction",
            "secret": "NOPE",
            "password": "NOPE",
        },
    )
    rec = json.loads(buf.getvalue())
    assert rec["level"] == "INFO"
    assert rec["message"] == "event_handled"
    assert rec["logger"].endswith("capture")
    assert "ts" in rec
    assert (
        rec["correlation_id"],
        rec["trace_id"],
        rec["ingestion_id"],
        rec["consumer"],
    ) == (
        "c1",
        "t1",
        "i1",
        "extraction",
    )
    # non-allow-listed extras NEVER leak into the log line
    assert "secret" not in rec and "password" not in rec


def test_exception_traceback_captured_serverside():
    lg, buf = _capture()
    try:
        raise ValueError("boom-detail")
    except ValueError:
        lg.exception(
            "unhandled_exception", extra={"error_code": "INTERNAL_ERROR", "status": 500}
        )
    rec = json.loads(buf.getvalue())
    assert rec["exc_type"] == "ValueError"
    assert "boom-detail" in rec["exc"]
    assert rec["error_code"] == "INTERNAL_ERROR" and rec["status"] == 500


def test_each_line_is_valid_json():
    lg, buf = _capture()
    lg.warning(
        "api_error",
        extra={
            "error_code": "DEPENDENCY_UNAVAILABLE",
            "status": 503,
            "path": "/v1/ingestions",
        },
    )
    for line in buf.getvalue().splitlines():
        json.loads(line)  # raises if any line is not valid JSON


def test_configure_logging_is_idempotent_and_namespaced():
    configure_logging()
    configure_logging()
    assert get_logger("outbox.worker").name == "labelscan.outbox.worker"
