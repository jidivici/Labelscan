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
