"""GS1 element-string parser (PURE domain — stdlib only, no framework/DB/LLM).

Decodes a GS1-128 / GS1 DataMatrix element string — as produced by a barcode
SCANNER (e.g. expo-camera's native read), NOT by OCR — into its Application
Identifiers (AIs). Data decoded here is mathematically exact: it comes from the
barcode symbology, so the reconciliation layer can assign it maximum trust.

This module ONLY parses. It does not touch the DB, the LLM, the confidence engine,
or the validation gate (those invariants are protected — see the reconciliation
layer for how this feeds them).

Supported input forms:
  * Human-readable, parenthesised:
        "(01)03700161210047(17)251231(10)LOT123"
  * Raw scan with FNC1 separators (FNC1 = GS, ASCII 0x1D):
        "0103700161210047" + FNC1 + "10LOT123" + FNC1 + "17251231"
    Fixed-length AIs need no separator; variable-length ones are FNC1-terminated.

Scope note: the full GS1 AI table is large. This parser covers the AIs relevant
to seafood HACCP traceability (GTIN, lot, the dates, net weight). Unknown AIs are
read defensively (to the next FNC1) and surfaced in `warnings`, never guessed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

FNC1 = "\x1d"  # GS / Group Separator — the GS1 variable-field terminator


def _normalise_scan(raw: str) -> str:
    """Remove scanner transport metadata while preserving GS1 payload bytes."""
    text = raw.strip()
    if len(text) >= 3 and text[0] == "]" and text[1].isalpha() and text[2].isdigit():
        text = text[3:]
    return text.replace("<GS>", FNC1).replace("{GS}", FNC1)

# Fixed-length AIs (AI -> payload length in characters). HACCP-relevant subset.
_FIXED_LEN: dict[str, int] = {
    "00": 18,  # SSCC
    "01": 14,  # GTIN
    "02": 14,  # GTIN of contained trade items
    "11": 6,  # production date  YYMMDD
    "12": 6,  # due date
    "13": 6,  # packaging date   YYMMDD
    "15": 6,  # best-before (DDM) YYMMDD
    "16": 6,  # sell-by
    "17": 6,  # use-by / expiration (DLC) YYMMDD
}

# Weight/measure family: 4-char AI "NNNx" where x is the implied decimal position;
# payload is always 6 digits. We decode the net-weight (kg) family for HACCP.
_MEASURE_PREFIXES = ("310", "311", "312", "313", "315", "316", "320", "321")
_FOUR_DIGIT_AIS = ("7030",)


@dataclass(frozen=True)
class Gs1Result:
    """Decoded GS1 element string. `elements` is every AI parsed (ai -> raw payload);
    the named fields are the HACCP-relevant decoded/normalised projections."""

    elements: dict[str, str]
    gtin: str | None = None  # AI 01 (14 digits)
    lot: str | None = None  # AI 10 (batch/lot)
    expiry_date: str | None = None  # AI 17 — use-by / DLC, ISO yyyy-mm-dd
    best_before: str | None = None  # AI 15 — DDM, ISO yyyy-mm-dd
    production_date: str | None = None  # AI 11, ISO yyyy-mm-dd
    packaging_date: str | None = None  # AI 13, ISO yyyy-mm-dd
    net_weight_kg: float | None = None  # AI 310x
    warnings: tuple[str, ...] = ()

    @property
    def is_empty(self) -> bool:
        return not self.elements


def _last_day(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (
        date(year, month + 1, 1).toordinal() - 1 - date(year, month, 1).toordinal()
    ) + 1


def _decode_date(yymmdd: str) -> str | None:
    """GS1 YYMMDD -> ISO yyyy-mm-dd. Day '00' means last day of the month (GS1 spec)."""
    if len(yymmdd) != 6 or not yymmdd.isdigit():
        return None
    yy, mm, dd = int(yymmdd[:2]), int(yymmdd[2:4]), int(yymmdd[4:6])
    if mm < 1 or mm > 12:
        return None
    year = 2000 + yy  # simplified 20xx window (sufficient for current product dates)
    if dd == 0:
        dd = _last_day(year, mm)
    try:
        return date(year, mm, dd).isoformat()
    except ValueError:
        return None


def _decode_measure(ai: str, payload: str) -> float | None:
    if len(payload) != 6 or not payload.isdigit():
        return None
    decimals = int(ai[3])  # the x in 310x
    return int(payload) / (10**decimals)


def _has_valid_gtin_check_digit(value: str) -> bool:
    if len(value) < 2 or not value.isdigit():
        return False
    weighted = sum(
        int(digit) * (3 if index % 2 == 0 else 1)
        for index, digit in enumerate(reversed(value[:-1]))
    )
    return int(value[-1]) == (10 - weighted % 10) % 10


def _read_ai(s: str, i: int) -> tuple[str | None, int]:
    """Return (ai, ai_length) at position i, or (None, 0) if unrecognisable."""
    if (
        i + 4 <= len(s)
        and (s[i : i + 3] in _MEASURE_PREFIXES or s[i : i + 4] in _FOUR_DIGIT_AIS)
        and s[i : i + 4].isdigit()
    ):
        return s[i : i + 4], 4
    two = s[i : i + 2]
    if two.isdigit():
        return two, 2
    return None, 0


def _parse_parenthesised(s: str) -> tuple[dict[str, str], list[str]]:
    elements: dict[str, str] = {}
    warnings: list[str] = []
    parts = re.split(r"\((\d{2,4})\)", s)
    if parts and parts[0].strip():
        warnings.append(f"ignored leading characters before first AI: {parts[0]!r}")
    it = iter(parts[1:])
    for ai in it:
        payload = next(it, "")
        elements[ai] = payload.replace(FNC1, "").strip()
    return elements, warnings


def _parse_positional(s: str) -> tuple[dict[str, str], list[str]]:
    elements: dict[str, str] = {}
    warnings: list[str] = []
    i, n = 0, len(s)
    while i < n:
        if s[i] == FNC1:
            i += 1
            continue
        ai, alen = _read_ai(s, i)
        if ai is None:
            warnings.append(f"unrecognised AI at position {i}: {s[i : i + 4]!r}")
            break  # stop rather than risk misaligned reads
        i += alen
        if ai in _FIXED_LEN:
            plen = _FIXED_LEN[ai]
            elements[ai] = s[i : i + plen]
            i += plen
        elif len(ai) == 4 and ai[:3] in _MEASURE_PREFIXES:
            elements[ai] = s[i : i + 6]
            i += 6
        else:
            # variable-length: read to the next FNC1 (or end of string)
            j = s.find(FNC1, i)
            if j == -1:
                j = n
            elements[ai] = s[i:j]
            i = j
    return elements, warnings


def parse_gs1(raw: str | None) -> Gs1Result:
    """Parse a GS1 element string into its AIs + HACCP-relevant decoded fields.

    Returns an empty result (is_empty == True) for empty/whitespace input. Never
    raises on malformed input — anomalies are recorded in `warnings`.
    """
    if not raw or not raw.strip():
        return Gs1Result(elements={})

    s = _normalise_scan(raw)
    elements, warnings = _parse_parenthesised(s) if "(" in s else _parse_positional(s)

    gtin = elements.get("01") or None
    if gtin is not None and (len(gtin) != 14 or not gtin.isdigit()):
        warnings.append(f"GTIN (AI 01) is not 14 digits: {gtin!r}")
    elif gtin is not None and not _has_valid_gtin_check_digit(gtin):
        warnings.append(f"Clé de contrôle GTIN (AI 01) à vérifier : {gtin!r}")

    lot = (elements.get("10") or "").strip() or None

    def _date(ai: str) -> str | None:
        raw_v = elements.get(ai)
        if raw_v is None:
            return None
        decoded = _decode_date(raw_v)
        if decoded is None:
            warnings.append(f"AI {ai} is not a valid YYMMDD date: {raw_v!r}")
        return decoded

    net_weight_kg: float | None = None
    for ai, payload in elements.items():
        if len(ai) == 4 and ai[:3] == "310":
            net_weight_kg = _decode_measure(ai, payload)
            if net_weight_kg is None:
                warnings.append(f"AI {ai} net weight payload invalid: {payload!r}")
            break

    return Gs1Result(
        elements=elements,
        gtin=gtin,
        lot=lot,
        expiry_date=_date("17"),
        best_before=_date("15"),
        production_date=_date("11"),
        packaging_date=_date("13"),
        net_weight_kg=net_weight_kg,
        warnings=tuple(warnings),
    )
