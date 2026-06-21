/**
 * GS1 element-string parser (client mirror of server/domain/gs1.py).
 *
 * Decodes a GS1-128 / GS1 DataMatrix element string as produced by the barcode
 * SCANNER (expo-camera's native read) — NOT by OCR — into its Application
 * Identifiers (AIs). This data is mathematically exact (it comes from the barcode
 * symbology), so the app can trust it the instant the photo is sent: it powers the
 * "GS1 at T+0s" half of the cascade — lot + DLC shown immediately while the LLM
 * fills the free-text fields. The backend remains the source of truth on save (it
 * runs the same decode + reconciliation server-side); this is a display preview.
 *
 * Supported input forms (same as the server):
 *   - Parenthesised:  "(01)03700161210047(17)251231(10)LOT123"
 *   - Raw scan with FNC1 (GS, 0x1D) separators; fixed-length AIs need no separator,
 *     variable-length ones are FNC1-terminated.
 *
 * Scope: the HACCP-relevant subset (GTIN, lot, the dates, net weight). Unknown AIs
 * are read defensively and surfaced in `warnings`, never guessed.
 */

import { displayDate } from './inputMasks';

const FNC1 = '\x1d'; // GS / Group Separator — the GS1 variable-field terminator

// Fixed-length AIs (AI -> payload length in characters). HACCP-relevant subset.
const FIXED_LEN: Record<string, number> = {
  '00': 18, // SSCC
  '01': 14, // GTIN
  '02': 14, // GTIN of contained trade items
  '11': 6, // production date  YYMMDD
  '12': 6, // due date
  '13': 6, // packaging date   YYMMDD
  '15': 6, // best-before      YYMMDD
  '16': 6, // sell-by
  '17': 6, // use-by / expiration (DLC) YYMMDD
};

// Weight/measure family: 4-char AI "NNNx" where x is the implied decimal position;
// payload is always 6 digits. We decode the net-weight (kg) family for HACCP.
const MEASURE_PREFIXES = ['310', '311', '312', '313', '315', '316', '320', '321'];

export interface Gs1Decoded {
  /** Every AI parsed (ai -> raw payload). */
  elements: Record<string, string>;
  gtin: string | null; // AI 01 (14 digits)
  lot: string | null; // AI 10 (batch/lot)
  expiryDate: string | null; // AI 17 — use-by / DLC, ISO yyyy-mm-dd
  bestBefore: string | null; // AI 15, ISO yyyy-mm-dd
  productionDate: string | null; // AI 11, ISO yyyy-mm-dd
  packagingDate: string | null; // AI 13, ISO yyyy-mm-dd
  netWeightKg: number | null; // AI 310x
  warnings: string[];
}

const isDigits = (s: string): boolean => s.length > 0 && /^\d+$/.test(s);
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Days in a 1-indexed month (matches GS1 day '00' = last day of month). */
function lastDay(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** GS1 YYMMDD -> ISO yyyy-mm-dd. Day '00' means last day of the month (GS1 spec). */
function decodeDate(yymmdd: string): string | null {
  if (yymmdd.length !== 6 || !isDigits(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  let dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12) return null;
  const year = 2000 + yy; // simplified 20xx window (sufficient for current product dates)
  if (dd === 0) dd = lastDay(year, mm);
  if (dd < 1 || dd > lastDay(year, mm)) return null;
  return `${year}-${pad2(mm)}-${pad2(dd)}`;
}

function decodeMeasure(ai: string, payload: string): number | null {
  if (payload.length !== 6 || !isDigits(payload)) return null;
  const decimals = Number(ai[3]); // the x in 310x
  return Number(payload) / 10 ** decimals;
}

/** Return [ai, aiLength] at position i, or [null, 0] if unrecognisable. */
function readAi(s: string, i: number): [string | null, number] {
  const four = s.slice(i, i + 4);
  if (four.length === 4 && MEASURE_PREFIXES.includes(s.slice(i, i + 3)) && isDigits(four)) {
    return [four, 4];
  }
  const two = s.slice(i, i + 2);
  if (isDigits(two) && two.length === 2) return [two, 2];
  return [null, 0];
}

function parseParenthesised(s: string): { elements: Record<string, string>; warnings: string[] } {
  const elements: Record<string, string> = {};
  const warnings: string[] = [];
  const parts = s.split(/\((\d{2,4})\)/);
  if (parts[0] && parts[0].trim()) {
    warnings.push(`ignored leading characters before first AI: ${JSON.stringify(parts[0])}`);
  }
  for (let k = 1; k < parts.length; k += 2) {
    const ai = parts[k];
    const payload = parts[k + 1] ?? '';
    elements[ai] = payload.split(FNC1).join('').trim();
  }
  return { elements, warnings };
}

function parsePositional(s: string): { elements: Record<string, string>; warnings: string[] } {
  const elements: Record<string, string> = {};
  const warnings: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] === FNC1) {
      i += 1;
      continue;
    }
    const [ai, alen] = readAi(s, i);
    if (ai === null) {
      warnings.push(`unrecognised AI at position ${i}: ${JSON.stringify(s.slice(i, i + 4))}`);
      break; // stop rather than risk misaligned reads
    }
    i += alen;
    if (ai in FIXED_LEN) {
      const plen = FIXED_LEN[ai];
      elements[ai] = s.slice(i, i + plen);
      i += plen;
    } else if (ai.length === 4 && MEASURE_PREFIXES.includes(ai.slice(0, 3))) {
      elements[ai] = s.slice(i, i + 6);
      i += 6;
    } else {
      // variable-length: read to the next FNC1 (or end of string)
      let j = s.indexOf(FNC1, i);
      if (j === -1) j = n;
      elements[ai] = s.slice(i, j);
      i = j;
    }
  }
  return { elements, warnings };
}

/**
 * Parse a GS1 element string into its AIs + HACCP-relevant decoded fields.
 * Returns an empty result for empty/whitespace input. Never throws on malformed
 * input — anomalies are recorded in `warnings`.
 */
export function parseGs1(raw: string | null | undefined): Gs1Decoded {
  const empty: Gs1Decoded = {
    elements: {},
    gtin: null,
    lot: null,
    expiryDate: null,
    bestBefore: null,
    productionDate: null,
    packagingDate: null,
    netWeightKg: null,
    warnings: [],
  };
  if (!raw || !raw.trim()) return empty;

  const s = raw.trim();
  const { elements, warnings } = s.includes('(') ? parseParenthesised(s) : parsePositional(s);

  const gtin = elements['01'] || null;
  if (gtin !== null && (gtin.length !== 14 || !isDigits(gtin))) {
    warnings.push(`GTIN (AI 01) is not 14 digits: ${JSON.stringify(gtin)}`);
  }

  const lot = (elements['10'] || '').trim() || null;

  const date = (ai: string): string | null => {
    const rawV = elements[ai];
    if (rawV === undefined) return null;
    const decoded = decodeDate(rawV);
    if (decoded === null) warnings.push(`AI ${ai} is not a valid YYMMDD date: ${JSON.stringify(rawV)}`);
    return decoded;
  };

  let netWeightKg: number | null = null;
  for (const [ai, payload] of Object.entries(elements)) {
    if (ai.length === 4 && ai.slice(0, 3) === '310') {
      netWeightKg = decodeMeasure(ai, payload);
      if (netWeightKg === null) warnings.push(`AI ${ai} net weight payload invalid: ${JSON.stringify(payload)}`);
      break;
    }
  }

  return {
    elements,
    gtin,
    lot,
    expiryDate: date('17'),
    bestBefore: date('15'),
    productionDate: date('11'),
    packagingDate: date('13'),
    netWeightKg,
    warnings,
  };
}

/** Render an AI 310x net weight (kg) as a compact display string, e.g. "1.5 kg". */
export function formatGs1WeightKg(kg: number): string {
  let s = kg.toFixed(3);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return `${s} kg`;
}

/**
 * GS1-decoded values keyed by extraction field name, formatted for display (dates →
 * DD/MM/YYYY, net weight → "x kg"). These are the fields GS1 resolves EXACTLY from the
 * barcode; they power the Review field list at T+0 (filled rows before the LLM run lands —
 * audit §2.1). Fields GS1 does not resolve are `undefined`.
 */
export function gs1FieldValues(gs1: Gs1Decoded): Record<string, string | undefined> {
  const expiry = gs1.expiryDate ?? gs1.bestBefore;
  return {
    batch_number: gs1.lot ?? undefined,
    expiry_date: expiry ? displayDate(expiry) : undefined,
    packaging_date: gs1.packagingDate ? displayDate(gs1.packagingDate) : undefined,
    weight: gs1.netWeightKg != null ? formatGs1WeightKg(gs1.netWeightKg) : undefined,
    gtin: gs1.gtin ?? undefined,
  };
}
