"""The message a consumer receives from the outbox relay."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class OutboxMessage:
    id: str  # the outbox row id — also the event_id used for consumer dedup
    event_type: str
    payload: dict[str, Any]
    correlation_id: str
    trace_id: str
