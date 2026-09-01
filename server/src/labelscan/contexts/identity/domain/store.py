"""Store directory entities owned by the identity/access context."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


def _safe_nfc_text(value: str, *, field: str) -> str:
    normalized = unicodedata.normalize("NFC", value)
    if any(
        unicodedata.category(character) in {"Cc", "Cf", "Cs"}
        for character in normalized
    ):
        raise ValueError(f"{field} contains control or direction characters")
    return normalized


def normalize_store_code(value: str) -> str:
    """Return the canonical store identifier or reject an invalid value."""
    normalized = _safe_nfc_text(value, field="store code").strip().upper()
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
    normalized = " ".join(
        _safe_nfc_text(value, field="store name").split()
    )
    if not normalized:
        raise ValueError("store name must not be blank")
    if len(normalized) > 120:
        raise ValueError("store name must be at most 120 characters")
    return normalized


def normalize_store_query(value: str | None) -> str | None:
    """Return a bounded store search term or ``None`` for an empty query."""

    if value is None:
        return None
    normalized = " ".join(
        _safe_nfc_text(value, field="store query").split()
    )
    if not normalized:
        return None
    if len(normalized) > 120:
        raise ValueError("store query must be at most 120 characters")
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
