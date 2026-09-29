"""Calendar dates printed on labels. Never supply a missing day or month."""
from __future__ import annotations

import re
import unicodedata
from datetime import date

_MONTH_GROUPS = (
    'jan janv january janvier', 'feb february fev fevr fevrier',
    'mar march mars', 'apr april avr avril', 'may mai', 'jun june juin',
    'jul july juil juillet', 'aug august aout', 'sep sept september septembre',
    'oct october octobre', 'nov november novembre', 'dec december decembre',
)
MONTHS = {name: month for month, names in enumerate(_MONTH_GROUPS, 1)
          for name in names.split()}
# Named months are intentionally exact: "jungle" must never become June.
_MONTH = '(?:' + '|'.join(sorted(MONTHS, key=len, reverse=True)) + ')'
DATE_PATTERN = (
    rf"(?:\d{{4}}[-/.]\d{{1,2}}[-/.]\d{{1,2}}|"
    rf"\d{{1,2}}[-/.]\d{{1,2}}[-/.](?:\d{{4}}|\d{{2}})|"
    rf"\d{{1,2}}(?:st|nd|rd|th|er)?[ ./-]+{_MONTH}\.?[ ,./-]+(?:\d{{4}}|\d{{2}})|"
    rf"{_MONTH}\.?[ ,./-]+\d{{1,2}}(?:st|nd|rd|th)?[,]?[ ./-]+(?:\d{{4}}|\d{{2}})|"
    rf"\d{{8}})"
)


def normalize_label_date(value: str, *, numeric_order: str | None = None) -> str | None:
    """DMY for French manual entry; OCR leaves ambiguous numeric order unresolved.

    Two-digit years mean 2000–2099. Eight digits require a four-digit year at
    the start (YYYYMMDD) or end (DDMMYYYY), never the ambiguous YYMMDD form.
    """
    text = ''.join(c for c in unicodedata.normalize('NFD', value.strip().lower())
                   if not unicodedata.combining(c))
    year = month = day = 0
    match = re.fullmatch(r'(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})', text)
    if match:
        year, month, day = map(int, match.groups())
    elif re.fullmatch(r'\d{8}', text):
        if 2000 <= int(text[:4]) <= 2100 and int(text[4:6]) <= 12:
            year, month, day = int(text[:4]), int(text[4:6]), int(text[6:])
        elif 2000 <= int(text[4:]) <= 2100:
            day, month, year = int(text[:2]), int(text[2:4]), int(text[4:])
        else:
            return None
    else:
        match = re.fullmatch(r'(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})', text)
        if match:
            first, second, year = map(int, match.groups())
            if first > 12 or first == second or numeric_order == 'DMY':
                day, month = first, second
                if second > 12 and first <= 12:
                    month, day = first, second
            elif second > 12 or numeric_order == 'MDY':
                month, day = first, second
            else:
                return None
        else:
            match = re.fullmatch(r'(\d{1,2})(?:st|nd|rd|th|er)?[ ./-]+([a-z]+)\.?[ ,./-]+(\d{4}|\d{2})', text)
            if match:
                day, token, year = match.groups()
            else:
                match = re.fullmatch(r'([a-z]+)\.?[ ,./-]+(\d{1,2})(?:st|nd|rd|th)?[,]?[ ./-]+(\d{4}|\d{2})', text)
                if not match:
                    return None
                token, day, year = match.groups()
            month, day, year = MONTHS.get(token, 0), int(day), int(year)
        if year < 100:
            year += 2000
    if not 2000 <= year <= 2100:
        return None
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None
