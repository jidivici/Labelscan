/**
 * Input masks + keyboard hints for the review form.
 *
 * These are INPUT helpers only: they format the characters the human types (e.g.
 * auto-insert "/" in a date), they NEVER invent, compute, or default a value. In
 * particular there is deliberately **no** "expiry = packaging + N days": shelf life
 * is not a constant (fresh fish = days, frozen = months), so a computed expiry would
 * be a fabrication of a safety-critical value and drive a wrong HACCP alert. The
 * operator reads every value off the label; the mask only formats their keystrokes.
 * (Consistent with the no-fabrication gate — docs/extraction/PROMPT-CONTRACT.md.)
 */

/** Fields the operator types as a calendar date (number-pad + DD/MM/YYYY mask). */
export const DATE_FIELDS = new Set(['expiry_date', 'packaging_date']);

export function isDateField(fieldName: string): boolean {
  return DATE_FIELDS.has(fieldName);
}

/**
 * Format raw keystrokes into a DD/MM/YYYY skeleton: keep digits only and auto-insert
 * "/" between day, month and year. Caps at 8 digits (DDMMYYYY) → at most "DD/MM/YYYY".
 * Pure and reversible-friendly: backspacing re-masks the shortened string. It never
 * adds a digit the user did not type.
 */
export function maskDate(input: string): string {
  const d = input.replace(/\D/g, '').slice(0, 8); // DDMMYYYY, max 8 digits
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

/**
 * Present a date value as DD/MM/YYYY (the operator's format). Converts a canonical
 * ISO `YYYY-MM-DD` (what the backend extraction produces) into `DD/MM/YYYY`; anything
 * already in DD/MM/YYYY, partial (`YYYY-MM`), or verbatim/unparseable is returned
 * unchanged (never mangled). Pure.
 *
 * NOTE: this is a PRESENTATION conversion only. ISO stays the canonical/backend format
 * — the gate's chronological check (`expiry < packaging`) relies on ISO lexical order,
 * which DD/MM/YYYY breaks across year boundaries. Any sync of edits back to the backend
 * must reconvert DD/MM/YYYY → ISO at that boundary.
 */
export function displayDate(value: string): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!iso) return value;
  const [, y, m, d] = iso;
  return `${d}/${m}/${y}`;
}

// ── Weight: "320 g" / "1.5 kg" ⇄ { amount, unit } ────────────────────────────────

export type WeightUnit = 'kg' | 'g';

/**
 * Split a weight string into a numeric amount + unit. Defaults to `kg` (the criée /
 * arrivage unit) when no unit is printed; recognises a bare `g`. NOTE: it does NOT
 * convert g↔kg — the amount stays as printed, so "320 g" never becomes "320 kg" (a
 * 1000× error). The operator can flip the unit explicitly.
 */
export function parseWeight(value: string): { amount: string; unit: WeightUnit } {
  const v = (value || '').trim();
  const num = /-?\d+(?:[.,]\d+)?/.exec(v);
  const amount = num ? num[0].replace(',', '.') : '';
  const unit: WeightUnit = /\bg\b/i.test(v) && !/kg/i.test(v) ? 'g' : 'kg';
  return { amount, unit };
}

/** Rebuild "amount unit" (e.g. "5 kg"); an empty amount → "". */
export function formatWeight(amount: string, unit: WeightUnit): string {
  const a = amount.trim().replace(',', '.');
  return a === '' ? '' : `${a} ${unit}`;
}

// ── Storage temperature: "0-4 C" / "<=4 C" ⇄ { min, max } in °C ───────────────────

/**
 * Parse a Celsius string into min/max bounds (either may be empty). Defensive about
 * the "-" that is both a minus sign and a range separator: a real range ("0-4",
 * "-2-4") fills both; a single bound ("<=4", ">=-18", "-18") fills one. Lossy on the
 * exact ≤/≥ wording — acceptable because the raw extraction run keeps the original and
 * we only reconstruct when the operator actually edits the field.
 */
export function parseTemp(value: string): { min: string; max: string } {
  const v = (value || '').trim();
  const range = /(-?\d+(?:[.,]\d+)?)\s*-\s*(-?\d+(?:[.,]\d+)?)/.exec(v);
  if (range) return { min: range[1].replace(',', '.'), max: range[2].replace(',', '.') };
  const single = /-?\d+(?:[.,]\d+)?/.exec(v);
  if (!single) return { min: '', max: '' };
  const n = single[0].replace(',', '.');
  if (/<=|≤|max/i.test(v)) return { min: '', max: n };
  if (/>=|≥|min/i.test(v)) return { min: n, max: '' };
  return { min: '', max: n }; // a bare single value → treat as the upper bound
}

/** Rebuild a Celsius string from min/max (mobile presentation uses "°C"). */
export function formatTemp(min: string, max: string): string {
  const mn = min.trim().replace(',', '.');
  const mx = max.trim().replace(',', '.');
  if (mn !== '' && mx !== '') return `${mn} - ${mx} °C`;
  if (mx !== '') return `${mx} °C`;
  if (mn !== '') return `${mn} °C`;
  return '';
}

// ── Price: "8.95 EUR" ⇄ { amount, currency } ─────────────────────────────────────

/**
 * Split a price string into a numeric amount + ISO-4217 currency. Defaults to EUR (the
 * criée standard) when none is printed; keeps an explicit 3-letter code if present. Never
 * invents a price — an empty input yields an empty amount.
 */
export function parsePrice(value: string): { amount: string; currency: string } {
  const v = (value || '').trim();
  const num = /-?\d+(?:[.,]\d+)?/.exec(v);
  const amount = num ? num[0].replace(',', '.') : '';
  const code = /\b([A-Z]{3})\b/.exec(v);
  return { amount, currency: code ? code[1] : 'EUR' };
}

/** Rebuild "amount currency" (e.g. "8.95 EUR"); an empty amount → "". */
export function formatPrice(amount: string, currency: string): string {
  const a = amount.trim().replace(',', '.');
  return a === '' ? '' : `${a} ${currency}`;
}

// ── Date canonicalization (storage = ISO; display = DD/MM/YYYY) ──────────────────

/**
 * DD/MM/YYYY → canonical ISO "YYYY-MM-DD". Already-ISO, partial ("YYYY-MM"), or an
 * unparseable string passes through UNCHANGED (never lose what the operator typed). The
 * exact inverse of displayDate; pure, structural reformat only (validity is validateDate's
 * job). Storing ISO keeps the backend chronological gate (expiry < packaging, ISO lexical
 * order) and the display format from drifting apart (audit §7.2 step 4 / §4.4).
 */
export function toIsoDate(value: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!m) return value.trim();
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

// ── Real-time validity hints — NEUTRAL and NON-BLOCKING (Clean UI: never red/blocking) ──
// Each returns a short FR hint when a COMPLETE value is implausible, or null when it is
// valid, empty, or still being typed. The operator stays in control: these never block the
// save and never auto-correct a value (no-fabrication — the operator reads the label).

/** Validity hint for a DD/MM/YYYY or ISO date. Partial input is not "invalid" (returns null). */
export function validateDate(value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  const fr = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  let day: number;
  let month: number;
  let year: number;
  if (fr) {
    day = +fr[1];
    month = +fr[2];
    year = +fr[3];
  } else if (iso) {
    year = +iso[1];
    month = +iso[2];
    day = +iso[3];
  } else {
    return null; // partial / mid-typing → not flagged yet
  }
  if (month < 1 || month > 12) return 'Mois invalide';
  if (year < 2000 || year > 2100) return 'Année invalide';
  // new Date(year, month, 0) = last day of the 1-indexed `month` (handles leap years).
  if (day < 1 || day > new Date(year, month, 0).getDate()) return 'Jour invalide';
  return null;
}

/** Validity hint for a temperature range: min must not exceed max; flag gross outliers. */
export function validateTempRange(min: string, max: string): string | null {
  const parse = (s: string): number | null => {
    const t = s.trim();
    if (t === '' || t === '-') return null; // empty or mid-typing a negative
    const n = Number(t.replace(',', '.'));
    return Number.isNaN(n) ? null : n;
  };
  const mn = parse(min);
  const mx = parse(max);
  if (mn !== null && mx !== null && mn > mx) return 'Min supérieur au max';
  for (const t of [mn, mx]) {
    if (t !== null && (t < -100 || t > 60)) return 'Température inhabituelle';
  }
  return null;
}

/** Validity hint for a weight amount: must be strictly positive. */
export function validateWeight(amount: string): string | null {
  const v = amount.trim();
  if (v === '' || v === '.' || v === ',') return null;
  const n = Number(v.replace(',', '.'));
  if (Number.isNaN(n)) return null; // mid-typing
  return n <= 0 ? 'Poids invalide' : null;
}
