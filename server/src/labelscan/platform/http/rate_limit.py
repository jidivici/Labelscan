"""Small process-local abuse controls for the single-replica MVP API."""

from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass


@dataclass(frozen=True)
class LimitExceeded(Exception):
    retry_after: int
    scope: str


def _positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value <= 0:
        raise RuntimeError(f"{name} must be positive")
    return value


class RateLimits:
    def __init__(self) -> None:
        self._events: dict[tuple[str, str], deque[float]] = defaultdict(deque)
        self._login_failures: dict[str, int] = defaultdict(int)
        self._blocked_until: dict[str, float] = {}
        self._holds_by_actor: dict[str, int] = defaultdict(int)
        self._holds_total = 0
        self._lock = threading.Lock()

    def reset(self) -> None:
        """Clear process-local counters when a new application instance is composed."""
        with self._lock:
            self._events.clear()
            self._login_failures.clear()
            self._blocked_until.clear()
            self._holds_by_actor.clear()
            self._holds_total = 0

    def _window(
        self, scope: str, key: str, *, limit: int, window_seconds: int
    ) -> None:
        now = time.monotonic()
        with self._lock:
            events = self._events[(scope, key)]
            cutoff = now - window_seconds
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= limit:
                retry = max(1, int(events[0] + window_seconds - now) + 1)
                raise LimitExceeded(retry, scope)
            events.append(now)

    def _check_window(
        self, scope: str, key: str, *, limit: int, window_seconds: int
    ) -> None:
        now = time.monotonic()
        with self._lock:
            events = self._events[(scope, key)]
            cutoff = now - window_seconds
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= limit:
                retry = max(1, int(events[0] + window_seconds - now) + 1)
                raise LimitExceeded(retry, scope)

    def check_login(self, client_ip: str, account_key: str) -> None:
        now = time.monotonic()
        with self._lock:
            blocked_until = self._blocked_until.get(account_key, 0)
            if blocked_until > now:
                raise LimitExceeded(max(1, int(blocked_until - now) + 1), "login_account")
        self._check_window(
            "login_ip",
            client_ip,
            limit=_positive_int("LABELSCAN_LOGIN_RATE_LIMIT", 5),
            window_seconds=_positive_int("LABELSCAN_LOGIN_RATE_WINDOW_SECONDS", 60),
        )

    def login_failed(self, client_ip: str, account_key: str) -> None:
        threshold = _positive_int("LABELSCAN_LOGIN_ACCOUNT_FAILURES", 5)
        cooldown = _positive_int("LABELSCAN_LOGIN_ACCOUNT_COOLDOWN_SECONDS", 60)
        with self._lock:
            self._events[("login_ip", client_ip)].append(time.monotonic())
            self._login_failures[account_key] += 1
            if self._login_failures[account_key] >= threshold:
                self._blocked_until[account_key] = time.monotonic() + cooldown
                self._login_failures[account_key] = 0

    def login_succeeded(self, account_key: str) -> None:
        with self._lock:
            self._login_failures.pop(account_key, None)
            self._blocked_until.pop(account_key, None)

    def check_ingestion(self, actor_id: str) -> None:
        self._window(
            "ingestion_burst",
            actor_id,
            limit=_positive_int("LABELSCAN_INGESTION_BURST_LIMIT", 20),
            window_seconds=_positive_int("LABELSCAN_INGESTION_BURST_WINDOW_SECONDS", 600),
        )
        self._window(
            "ingestion_sustained",
            actor_id,
            limit=_positive_int("LABELSCAN_INGESTION_SUSTAINED_LIMIT", 120),
            window_seconds=_positive_int(
                "LABELSCAN_INGESTION_SUSTAINED_WINDOW_SECONDS", 3600
            ),
        )

    def check_mutation(self, actor_id: str) -> None:
        self._window(
            "mutation",
            actor_id,
            limit=_positive_int("LABELSCAN_MUTATION_LIMIT", 600),
            window_seconds=_positive_int("LABELSCAN_MUTATION_WINDOW_SECONDS", 3600),
        )

    def acquire_hold(self, actor_id: str) -> None:
        per_actor = _positive_int("LABELSCAN_LONG_POLL_PER_ACTOR", 4)
        global_limit = _positive_int("LABELSCAN_LONG_POLL_GLOBAL", 100)
        with self._lock:
            if self._holds_by_actor[actor_id] >= per_actor:
                raise LimitExceeded(1, "long_poll_actor")
            if self._holds_total >= global_limit:
                raise LimitExceeded(1, "long_poll_global")
            self._holds_by_actor[actor_id] += 1
            self._holds_total += 1

    def release_hold(self, actor_id: str) -> None:
        with self._lock:
            if self._holds_by_actor.get(actor_id, 0) > 0:
                self._holds_by_actor[actor_id] -= 1
                self._holds_total -= 1
                if self._holds_by_actor[actor_id] == 0:
                    self._holds_by_actor.pop(actor_id, None)


rate_limits = RateLimits()
