"""Per-process observability and pacing for billable external API calls.

OCR and LLM calls run in worker processes, not in the HTTP process. Keeping the
counter next to the SDK boundary measures every real outbound request, including
retries, without recording label contents, credentials, or response bodies.
"""

from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque
from contextlib import AbstractContextManager
from dataclasses import dataclass, field

_PROVIDER_ENV = {
    "google_vision": ("LABELSCAN_GOOGLE_VISION_RPS", 5),
    "anthropic": ("LABELSCAN_ANTHROPIC_RPS", 2),
}


def configured_rps(provider: str) -> int:
    """Return the configured per-worker ceiling for one external provider."""

    try:
        name, default = _PROVIDER_ENV[provider]
    except KeyError as exc:
        raise ValueError(f"unknown external provider: {provider}") from exc
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a positive integer") from exc
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive integer")
    return value


@dataclass
class ExternalApiRateLimitExceeded(RuntimeError):
    """A local worker would exceed its configured external-provider RPS."""

    provider: str
    retry_after: float

    def __str__(self) -> str:
        return f"{self.provider} external API rate limit exceeded"


@dataclass
class _ProviderStats:
    started: int = 0
    succeeded: int = 0
    failed: int = 0
    rate_limited: int = 0
    in_flight: int = 0
    total_latency_ms: float = 0.0
    max_latency_ms: float = 0.0
    recent_starts: deque[float] = field(default_factory=deque)


class _ExternalCall(AbstractContextManager["_ExternalCall"]):
    def __init__(self, monitor: "ExternalApiMonitor", provider: str, rps: int) -> None:
        self._monitor = monitor
        self._provider = provider
        self._rps = rps
        self._started_at: float | None = None

    def __enter__(self) -> "_ExternalCall":
        self._started_at = self._monitor._start(self._provider, self._rps)
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> bool:
        assert self._started_at is not None
        self._monitor._finish(
            self._provider,
            latency_ms=(time.monotonic() - self._started_at) * 1000.0,
            succeeded=exc_type is None,
        )
        return False


class ExternalApiMonitor:
    """Thread-safe sliding-window limiter and cumulative outbound metrics."""

    def __init__(self) -> None:
        self._stats: dict[str, _ProviderStats] = defaultdict(_ProviderStats)
        self._lock = threading.Lock()

    def reset(self) -> None:
        """Clear process-local measurements (used when a worker is rebuilt/tests run)."""

        with self._lock:
            self._stats.clear()

    def call(self, provider: str, *, rps: int | None = None) -> _ExternalCall:
        return _ExternalCall(
            self, provider, configured_rps(provider) if rps is None else rps
        )

    def _start(self, provider: str, rps: int) -> float:
        if rps <= 0:
            raise ValueError("rps must be positive")
        now = time.monotonic()
        with self._lock:
            stats = self._stats[provider]
            cutoff = now - 1.0
            while stats.recent_starts and stats.recent_starts[0] <= cutoff:
                stats.recent_starts.popleft()
            if len(stats.recent_starts) >= rps:
                stats.rate_limited += 1
                retry_after = max(0.001, stats.recent_starts[0] + 1.0 - now)
                raise ExternalApiRateLimitExceeded(provider, retry_after)
            stats.recent_starts.append(now)
            stats.started += 1
            stats.in_flight += 1
        return now

    def _finish(self, provider: str, *, latency_ms: float, succeeded: bool) -> None:
        with self._lock:
            stats = self._stats[provider]
            stats.in_flight -= 1
            stats.total_latency_ms += latency_ms
            stats.max_latency_ms = max(stats.max_latency_ms, latency_ms)
            if succeeded:
                stats.succeeded += 1
            else:
                stats.failed += 1

    def snapshot(self) -> dict[str, dict[str, int | float]]:
        """Return safe scalar metrics for the current worker process only."""

        now = time.monotonic()
        with self._lock:
            result: dict[str, dict[str, int | float]] = {}
            for provider in _PROVIDER_ENV:
                stats = self._stats[provider]
                cutoff = now - 1.0
                while stats.recent_starts and stats.recent_starts[0] <= cutoff:
                    stats.recent_starts.popleft()
                completed = stats.succeeded + stats.failed
                result[provider] = {
                    "configured_rps": configured_rps(provider),
                    "requests_total": stats.started,
                    "success_total": stats.succeeded,
                    "failure_total": stats.failed,
                    "rate_limited_total": stats.rate_limited,
                    "requests_last_second": len(stats.recent_starts),
                    "in_flight": stats.in_flight,
                    "latency_avg_ms": round(stats.total_latency_ms / completed, 1)
                    if completed
                    else 0.0,
                    "latency_max_ms": round(stats.max_latency_ms, 1),
                }
        return result


external_api_monitor = ExternalApiMonitor()
