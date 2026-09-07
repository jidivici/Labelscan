"""Interim deterministic field extraction (Tier 3 wave 2) — pure, no dependencies.

Conservative regex extractors over the raw OCR text, run BETWEEN the OCR and the
LLM so the client can render a preview ~seconds before the run lands. The rules:

  * Emit ONLY on an unambiguous, explicitly-labelled match (never a bare date or
    number without its label key) — consistent with the no-fabrication gate.
  * Emit the SAME canonical string form the LLM contract produces ("YYYY-MM-DD",
    "0-4 C", verbatim lot) so the final run confirms rather than
    flickers the preview.
  * When several DISTINCT candidates match one field, emit NOTHING for it —
    ambiguity is the LLM's job, not a coin flip.
  * Most output is NON-AUTHORITATIVE preview data. Two high-precision rules
    (sanitary approval mark and explicit farmed wording) are also exposed to the
    extraction consumer, which sends their exact OCR evidence through the same
    anti-fabrication gate as model output.

Numeric-date order follows the prompt contract rule: a component >12 is the day;
when BOTH leading components are <=12 the order is ambiguous and the date is
skipped (never guessed).
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class InterimField:
    name: str
    value: str
    evidence: str | None = None
    validation_status: str = "present"


# ── text normalization ────────────────────────────────────────────────────────

def _norm(text: str) -> str:
    # lowercase + fold the apostrophe/accent variants OCR produces, so the label
    # keys match regardless of typography ("À CONSOMMER JUSQU'AU", "jusqu’au", …).
    t = text.lower().replace("’", "'")
    for src, dst in (("à", "a"), ("â", "a"), ("é", "e"), ("è", "e"), ("ê", "e"), ("î", "i"), ("ô", "o"), ("û", "u"), ("ç", "c")):
        t = t.replace(src, dst)
    return t


# ── dates ─────────────────────────────────────────────────────────────────────

# ISO first (already canonical), then numeric D<sep>M<sep>Y in FR label order.
_ISO_DATE = r"(20\d{2})-(\d{2})-(\d{2})"
_NUM_DATE = r"(\d{1,2})[./-](\d{1,2})[./-](\d{2}(?:\d{2})?)"
_DATE_ALT = f"(?:{_ISO_DATE}|{_NUM_DATE})"

# Label keys, matched on the normalized (lowercase, accent-folded) text. The date
# must follow within a few junk characters (": le ", " - ") — a date elsewhere on
# the label is NOT attributed to the key.
_EXPIRY_KEYS = (
    r"dlc",
    r"a consommer jusqu'?\s?au",
    r"a consommer avant le",
    r"a consommer avant",
    r"use by",
    r"exp\.?",
)
_PACKAGING_KEYS = (
    r"emballe le",
    r"conditionne le",
    r"date d'emballage",
    r"date de conditionnement",
    r"packed on",
)


def _valid_ymd(year: int, month: int, day: int) -> str | None:
    if not (2000 <= year <= 2099 and 1 <= month <= 12 and 1 <= day <= 31):
        return None
    return f"{year:04d}-{month:02d}-{day:02d}"


def _normalize_date_match(m: re.Match) -> str | None:
    if m.group(1) is not None:  # ISO branch
        return _valid_ymd(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    a, b = int(m.group(4)), int(m.group(5))
    y = m.group(6)
    year = int(y) + 2000 if len(y) == 2 else int(y)
    # Prompt-contract order rule: a component >12 is the day; both <=12 = ambiguous.
    if a > 12 and b <= 12:
        return _valid_ymd(year, b, a)
    if b > 12 and a <= 12:
        return _valid_ymd(year, a, b)
    return None  # both <=12 (order-ambiguous) or both >12 (invalid) — never guess


def _dates_after_keys(norm_text: str, keys: tuple[str, ...]) -> set[str]:
    found: set[str] = set()
    for key in keys:
        for m in re.finditer(rf"{key}\s*[:.]?\s*(?:le\s+)?.{{0,6}}?{_DATE_ALT}", norm_text):
            iso = _normalize_date_match(m)
            if iso is not None:
                found.add(iso)
    return found


# ── storage temperature ───────────────────────────────────────────────────────

_TEMP_NUM = r"([+-]?\d{1,2}(?:[.,]\d)?)"
# Franc range forms only: "entre 0°C et +4°C", "entre 0 et 4 °c", "0°c / +4°c".
_TEMP_RANGE_ENTRE = re.compile(
    rf"entre\s*{_TEMP_NUM}\s*°?\s*c?\s*et\s*{_TEMP_NUM}\s*°\s*c"
)
_TEMP_RANGE_SLASH = re.compile(rf"{_TEMP_NUM}\s*°?\s*c?\s*/\s*{_TEMP_NUM}\s*°\s*c")


def _temp_num(s: str) -> str:
    n = s.replace(",", ".").lstrip("+")
    if n.endswith(".0"):
        n = n[:-2]
    return n


def _temperatures(norm_text: str) -> set[str]:
    found: set[str] = set()
    for rx in (_TEMP_RANGE_ENTRE, _TEMP_RANGE_SLASH):
        for m in rx.finditer(norm_text):
            lo, hi = _temp_num(m.group(1)), _temp_num(m.group(2))
            try:
                if float(lo) < float(hi):
                    found.add(f"{lo}-{hi} C")  # canonical contract form ("0-4 C")
            except ValueError:
                continue
    return found


# ── batch number ──────────────────────────────────────────────────────────────

# Explicit lot key, then the identifier (must contain a digit, length >= 3). Runs
# on the ORIGINAL text so the emitted value keeps the label's exact casing.
_BATCH_RX = re.compile(
    r"(?:lot|n[°o]\s*de\s*lot|batch)\s*(?:n[°o])?\s*[:.]?\s*([A-Za-z0-9][A-Za-z0-9./-]{2,})",
    re.IGNORECASE,
)


def _batches(original_text: str) -> set[str]:
    found: set[str] = set()
    for m in _BATCH_RX.finditer(original_text):
        token = m.group(1).rstrip(".")
        if any(ch.isdigit() for ch in token):
            found.add(token)
    return found


# ── high-precision regulatory fields ─────────────────────────────────────────

# EU sanitary / identification marks contain a two-letter country prefix, at
# least one digit in every approval-code group, and an explicit CE/UE/etc.
# suffix. Requiring that suffix avoids confusing origins and dates with marks.
_MARK_TOKEN = r"[A-Z0-9]*\d[A-Z0-9]*"
_MARK_SEPARATOR = r"[ ./\r\n-]+"
_EU_HEALTH_MARK_RX = re.compile(
    rf"(?<![A-Z0-9])(?P<mark>[A-Z]{{2}}\s+{_MARK_TOKEN}"
    rf"(?:{_MARK_SEPARATOR}{_MARK_TOKEN}){{0,5}}\s+"
    r"(?:CE|UE|EC|EG|EK))(?![A-Z0-9])",
    re.IGNORECASE,
)
# UK marks may be printed without an EU suffix (for example "GB BB004").
_GB_HEALTH_MARK_RX = re.compile(
    r"(?<![A-Z0-9])(?P<mark>GB\s+[A-Z]{1,4}\d{2,8})(?![A-Z0-9])",
    re.IGNORECASE,
)

_FARMED_RX = re.compile(
    r"\b(?:"
    r"eleve(?:e|es|s)?(?:\s+en)?|elevage|aquaculture|pisciculture|"
    r"farmed|farm[ -]raised|reared|raised"
    r")\b"
)
_GENERIC_AQUACULTURE_RX = re.compile(
    r"produits?\s+de\s+la\s+peche\s+et\s+de\s+l[' ]aquaculture"
)
_GENERIC_GEAR_RX = re.compile(
    r"engins?\s+de\s+peche\s*(?:/|ou|et)\s*(?:d[' ]\s*)?elevage"
)


def _health_mark(original_text: str) -> InterimField | None:
    candidates: dict[str, str] = {}
    eu_matches = tuple(_EU_HEALTH_MARK_RX.finditer(original_text))
    matches = eu_matches or tuple(_GB_HEALTH_MARK_RX.finditer(original_text))
    for match in matches:
        evidence = match.group("mark")
        value = re.sub(r"\s+", " ", evidence).strip()
        candidates.setdefault(value.upper(), evidence)
    if len(candidates) != 1:
        return None
    normalized, evidence = next(iter(candidates.items()))
    return InterimField(
        name="health_mark",
        value=normalized,
        evidence=evidence,
        validation_status=("present" if normalized == evidence else "normalized"),
    )


def _inside_any(index: int, spans: tuple[tuple[int, int], ...]) -> bool:
    return any(start <= index < end for start, end in spans)


def _farmed_method(original_text: str) -> InterimField | None:
    normalized = _norm(original_text)
    excluded = tuple(
        (match.start(), match.end())
        for pattern in (_GENERIC_AQUACULTURE_RX, _GENERIC_GEAR_RX)
        for match in pattern.finditer(normalized)
    )
    for match in _FARMED_RX.finditer(normalized):
        if _inside_any(match.start(), excluded):
            continue
        # `_norm` folds one Unicode character to one character, so these offsets
        # still select the exact original OCR substring required by the gate.
        evidence = original_text[match.start() : match.end()]
        return InterimField(
            name="production_method",
            value="farmed",
            evidence=evidence,
            validation_status="normalized",
        )
    return None


def extract_high_precision_ocr_fields(full_text: str) -> tuple[InterimField, ...]:
    """Exact OCR-backed values safe enough to complement the model result."""
    if not full_text:
        return ()
    return tuple(
        field
        for field in (_health_mark(full_text), _farmed_method(full_text))
        if field is not None
    )


# ── public API ────────────────────────────────────────────────────────────────

def extract_interim_fields(full_text: str) -> tuple[InterimField, ...]:
    """Conservative wave-2 preview fields from raw OCR text.

    Per field: all candidate matches are collected and the field is emitted ONLY
    when they agree on exactly one value. Field names + value forms mirror the
    extraction contract so the final run swap is value-stable.
    """
    if not full_text:
        return ()
    norm = _norm(full_text)

    candidates: dict[str, set[str]] = {
        "expiry_date": _dates_after_keys(norm, _EXPIRY_KEYS),
        "packaging_date": _dates_after_keys(norm, _PACKAGING_KEYS),
        "storage_temperature": _temperatures(norm),
        "batch_number": _batches(full_text),
    }
    preview = tuple(
        InterimField(name=name, value=next(iter(values)))
        for name, values in candidates.items()
        if len(values) == 1
    )
    return preview + extract_high_precision_ocr_fields(full_text)
