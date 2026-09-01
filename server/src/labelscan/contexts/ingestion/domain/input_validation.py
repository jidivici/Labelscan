"""Pure validation for untrusted ingestion and human-review text.

The database driver already parameterizes every SQL value.  These guards address the
other half of the boundary: hostile control characters, UI direction spoofing,
unbounded values and malformed safety-critical fields must never reach storage.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import UTC, date, datetime

from labelscan.business_profiles import field_spec

MAX_FIELD_VALUE_CHARS = 512
MAX_NOTE_CHARS = 2_000
MAX_BARCODE_CHARS = 128
MAX_IDEMPOTENCY_KEY_CHARS = 128

_IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/=+@-]{0,127}$")
_GTIN_LENGTHS = frozenset({8, 12, 13, 14})
_WEIGHT = re.compile(r"^(\d+(?:[.,]\d{1,3})?)\s*(g|kg)$", re.IGNORECASE)
_TEMPERATURE = re.compile(
    r"^(?:(<=|>=|≤|≥)\s*)?(-?\d+(?:[.,]\d+)?)"
    r"(?:\s*(?:-|–|à)\s*(-?\d+(?:[.,]\d+)?))?\s*°?C$",
    re.IGNORECASE,
)
_HEALTH_MARK = re.compile(r"^[A-Z]{2}[ A-Z0-9.\-/]{1,61}$")
_FAO_AREA = re.compile(r"^[^\W_](?:[^\W_]|[ .,/()'\-]){0,119}$", re.UNICODE)
_COUNTRY = re.compile(r"^[^\W\d_][\w .\-'’]{0,79}$", re.UNICODE)
# Directional overrides can make stored values look like different text in the UI,
# logs and exports.  They have no legitimate place on a product label form.
_BIDI_CONTROLS = frozenset(
    {
        "\u061c",
        "\u200e",
        "\u200f",
        "\u202a",
        "\u202b",
        "\u202c",
        "\u202d",
        "\u202e",
        "\u2066",
        "\u2067",
        "\u2068",
        "\u2069",
    }
)


def _normalize_safe_text(
    value: str,
    *,
    label: str,
    max_chars: int,
    allow_newlines: bool,
    allow_group_separator: bool = False,
) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    normalized = unicodedata.normalize("NFC", value).strip()
    if len(normalized) > max_chars:
        raise ValueError(f"{label} must be at most {max_chars} characters")
    for char in normalized:
        if char in _BIDI_CONTROLS:
            raise ValueError(
                f"{label} contains a forbidden direction-control character"
            )
        if allow_group_separator and char == "\x1d":
            continue
        if allow_newlines and char in "\n\r\t":
            continue
        category = unicodedata.category(char)
        if category in {"Cc", "Cf", "Cs"}:
            raise ValueError(f"{label} contains a forbidden control character")
    return normalized


def validate_idempotency_key(value: str | None, *, required: bool) -> str | None:
    if value is None or not value.strip():
        if required:
            raise ValueError("Idempotency-Key header is required")
        return None
    normalized = value.strip()
    if len(normalized) > MAX_IDEMPOTENCY_KEY_CHARS or not _IDEMPOTENCY_KEY.fullmatch(
        normalized
    ):
        raise ValueError("Idempotency-Key must contain 1-128 safe ASCII characters")
    return normalized


def validate_barcode_raw(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    return _normalize_safe_text(
        value,
        label="barcode_raw",
        max_chars=MAX_BARCODE_CHARS,
        allow_newlines=False,
        allow_group_separator=True,
    )


def validate_client_captured_at(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    raw = value.strip()
    if len(raw) > 64:
        raise ValueError("client_captured_at must be at most 64 characters")
    try:
        captured = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(
            "client_captured_at must be a valid ISO-8601 timestamp"
        ) from exc
    if captured.tzinfo is None or captured.utcoffset() is None:
        raise ValueError("client_captured_at must include a timezone")
    return captured.astimezone(UTC).isoformat().replace("+00:00", "Z")


def validate_note(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    return _normalize_safe_text(
        value,
        label="note",
        max_chars=MAX_NOTE_CHARS,
        allow_newlines=True,
    )


def _valid_gtin(value: str) -> bool:
    if len(value) not in _GTIN_LENGTHS or not value.isascii() or not value.isdigit():
        return False
    payload = [int(digit) for digit in value[:-1]]
    weighted = sum(
        digit * (3 if index % 2 == 0 else 1)
        for index, digit in enumerate(reversed(payload))
    )
    return (10 - weighted % 10) % 10 == int(value[-1])


def _valid_iso_date(value: str) -> bool:
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return False
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def validate_human_field_value(field_name: str, value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    normalized = _normalize_safe_text(
        value,
        label=f"field '{field_name}'",
        max_chars=min(MAX_FIELD_VALUE_CHARS, field_spec(field_name).max_length),
        allow_newlines=True,
    )
    # NC is the explicit, audited "non communiqué" value accepted by the final
    # review workflow.  It is never confused with a machine-extracted value.
    if normalized.upper() == "NC":
        return "NC"
    spec = field_spec(field_name)
    if spec.kind == "date" and not _valid_iso_date(normalized):
        raise ValueError(f"field '{field_name}' must be a complete YYYY-MM-DD date")
    if spec.kind == "enum" and normalized not in spec.enum:
        raise ValueError(
            f"field '{field_name}' must be one of {', '.join(spec.enum)} or NC"
        )
    if spec.kind == "gtin" and not _valid_gtin(normalized):
        raise ValueError(
            "field 'gtin' must have a valid GTIN-8/12/13/14 checksum or NC"
        )
    if spec.kind == "decimal_unit":
        match = _WEIGHT.fullmatch(normalized)
        if not match or float(match.group(1).replace(",", ".")) <= 0:
            raise ValueError(
                "field 'weight' must be a positive decimal followed by g or kg"
            )
        normalized = f"{match.group(1).replace(',', '.')} {match.group(2).lower()}"
    if spec.kind == "temperature_range":
        match = _TEMPERATURE.fullmatch(normalized)
        if not match:
            raise ValueError(
                "field 'storage_temperature' must be a Celsius value or range"
            )
        first = float(match.group(2).replace(",", "."))
        second = float(match.group(3).replace(",", ".")) if match.group(3) else None
        if (
            first < -100
            or first > 60
            or (second is not None and (second < -100 or second > 60))
        ):
            raise ValueError(
                "field 'storage_temperature' is outside the accepted range"
            )
        if second is not None and first > second:
            raise ValueError("field 'storage_temperature' minimum exceeds maximum")
    if spec.kind == "health_mark" and not _HEALTH_MARK.fullmatch(normalized.upper()):
        raise ValueError("field 'health_mark' has an invalid regulatory mark format")
    if spec.kind == "fao_area" and not _FAO_AREA.fullmatch(normalized.upper()):
        raise ValueError("field 'FAO_area' has an invalid FAO area format")
    if spec.kind == "country" and not _COUNTRY.fullmatch(normalized):
        raise ValueError(f"field '{field_name}' has an invalid country format")
    return normalized
