"""Store directory entities owned by the identity/access context."""

from __future__ import annotations

import re
from dataclasses import dataclass


def normalize_store_code(value: str) -> str:
    """Return the canonical store identifier or reject an invalid value."""
    normalized = value.strip().upper()
    if not normalized:
        raise ValueError("store code must not be blank")
    if len(normalized) > 64:
        raise ValueError("store code must be at most 64 characters")
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9._-]*", normalized):
        raise ValueError(
            "store code may contain only letters, numbers, dots, dashes and underscores"
        )
    return normalized


def normalize_store_name(value: str) -> str:
    """Normalize human-facing whitespace while preserving the store name."""
    normalized = " ".join(value.split())
    if not normalized:
        raise ValueError("store name must not be blank")
    if len(normalized) > 120:
        raise ValueError("store name must be at most 120 characters")
    return normalized


@dataclass(frozen=True)
class Store:
    id: str
    code: str
    name: str
    active: bool
    created_by: str
    created_at: str
    updated_at: str
    organization_id: str | None = None
