"""Pure retry-scheduling math for the outbox relay — exponential backoff + jitter.

Dependency-free on purpose: this module imports ONLY the standard library (no
sqlalchemy / alembic / framework code), so it obeys the domain-purity rule from
CLAUDE.md and can be reasoned about and unit-tested in isolation. The worker
(platform, an adapter) is the only caller; it feeds the result straight into the
`next_retry_at` column.

Jitter strategy — "equal jitter" (half fixed + half random):

    delay = capped/2 + random()*capped/2          # capped = min(base*2^(n-1), cap)

Full jitter (`random()*capped`) is the textbook anti-thundering-herd choice, but
its delay can shrink between attempts, which would make "backoff grows" assertions
flaky. Equal jitter keeps the SAME herd-spreading randomness while guaranteeing the
per-attempt floor doubles, so delay(n+1) > delay(n) holds deterministically — the
property R-B01's tests assert.
"""

from __future__ import annotations

import random
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

# Tunable defaults. base=2s, cap=1h keeps a poison pill's retries from growing
# without bound while MAX_RETRIES (3) is still reached within a few seconds in tests.
DEFAULT_BASE_SECONDS: float = 2.0
DEFAULT_CAP_SECONDS: float = 3600.0


def backoff_delay_seconds(
    attempt: int,
    *,
    base_seconds: float = DEFAULT_BASE_SECONDS,
    cap_seconds: float = DEFAULT_CAP_SECONDS,
    rng: Callable[[], float] = random.random,
) -> float:
    """Delay (seconds) before the `attempt`-th retry. `attempt` is 1-based.

    Exponential base-2 growth, clamped to `cap_seconds`, then equal-jittered.
    `rng` returns a float in [0, 1) (injectable for deterministic tests).
    """
    if attempt < 1:
        raise ValueError(f"attempt must be >= 1, got {attempt}")
    exponential = base_seconds * (2 ** (attempt - 1))
    capped = min(exponential, cap_seconds)
    half = capped / 2.0
    return half + rng() * half


def calculate_backoff(
    attempt: int,
    *,
    now: datetime | None = None,
    base_seconds: float = DEFAULT_BASE_SECONDS,
    cap_seconds: float = DEFAULT_CAP_SECONDS,
    rng: Callable[[], float] = random.random,
) -> datetime:
    """Absolute UTC instant before which the event must not be re-claimed.

    `now` defaults to the current UTC time; pass it explicitly to keep tests
    deterministic. The returned value lands in the `next_retry_at` column.
    """
    reference = now if now is not None else datetime.now(UTC)
    delay = backoff_delay_seconds(
        attempt, base_seconds=base_seconds, cap_seconds=cap_seconds, rng=rng
    )
    return reference + timedelta(seconds=delay)
