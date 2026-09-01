"""Unit proofs for outbound-provider metrics and the per-worker RPS ceiling."""

from __future__ import annotations

import pytest

from labelscan.platform.external_api import (
    ExternalApiMonitor,
    ExternalApiRateLimitExceeded,
)


def test_external_provider_records_latency_and_exact_rps_ceiling(monkeypatch):
    monkeypatch.delenv("LABELSCAN_GOOGLE_VISION_RPS", raising=False)
    monitor = ExternalApiMonitor()

    with monitor.call("google_vision", rps=1):
        pass

    with pytest.raises(ExternalApiRateLimitExceeded) as limited:
        with monitor.call("google_vision", rps=1):
            pass

    assert limited.value.provider == "google_vision"
    assert limited.value.retry_after > 0
    metrics = monitor.snapshot()["google_vision"]
    assert metrics["configured_rps"] == 5
    assert metrics["requests_total"] == 1
    assert metrics["success_total"] == 1
    assert metrics["failure_total"] == 0
    assert metrics["rate_limited_total"] == 1
    assert metrics["requests_last_second"] == 1
    assert metrics["in_flight"] == 0
    assert metrics["latency_avg_ms"] >= 0


def test_external_provider_records_a_failed_outbound_call():
    monitor = ExternalApiMonitor()

    with pytest.raises(RuntimeError, match="provider unavailable"):
        with monitor.call("anthropic", rps=3):
            raise RuntimeError("provider unavailable")

    metrics = monitor.snapshot()["anthropic"]
    assert metrics["requests_total"] == 1
    assert metrics["success_total"] == 0
    assert metrics["failure_total"] == 1
    assert metrics["in_flight"] == 0
