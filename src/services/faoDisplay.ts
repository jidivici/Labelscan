/**
 * FAO area DISPLAY formatter (presentation only — it never changes the stored value).
 *
 * Renders the extracted FAO designation in a human-readable form, e.g.
 *   "27"                                  → "27 Atlantique Nord-Est"
 *   "27.5"                                → "27 Atlantique Nord-Est - Sous zone: (V)"
 *   "Atlantique Nord-Est, sous-zone VIII" → "27 Atlantique Nord-Est - Sous zone: (VIII)"
 *
 * This is DETERMINISTIC official FAO nomenclature (area number ↔ official name; sub-area
 * → Roman numeral). It is NOT a place-name→code lookup and NOT a suggestion: it only
 * re-presents what was already extracted, and falls back to the verbatim value when it
 * cannot map the area.
 */

// FAO major fishing areas relevant to the French market (official FR names).
const AREA_NAMES: Record<number, string> = {
  21: 'Atlantique Nord-Ouest',
  27: 'Atlantique Nord-Est',
  31: 'Atlantique Centre-Ouest',
  34: 'Atlantique Centre-Est',
  37: 'Méditerranée et mer Noire',
  41: 'Atlantique Sud-Ouest',
  47: 'Atlantique Sud-Est',
  51: 'Océan Indien Ouest',
  57: 'Océan Indien Est',
  61: 'Pacifique Nord-Ouest',
  67: 'Pacifique Nord-Est',
  71: 'Pacifique Centre-Ouest',
  77: 'Pacifique Centre-Est',
  81: 'Pacifique Sud-Ouest',
  87: 'Pacifique Sud-Est',
};

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV'];

function toRoman(n: number): string {
  return n >= 1 && n < ROMAN.length ? ROMAN[n] : String(n);
}

function fromRoman(tok: string): number | null {
  const i = ROMAN.indexOf(tok.toUpperCase());
  return i > 0 ? i : null;
}

function normalize(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase().normalize('NFD')) {
    const c = ch.charCodeAt(0);
    if (c >= 0x300 && c <= 0x36f) continue; // strip accents
    out += ch;
  }
  return out;
}

// Official area NAME → number (for worded designations like "Atlantique Nord-Est").
const NAME_PATTERNS: ReadonlyArray<readonly [RegExp, number]> = [
  [/atlantique\s+(?:du\s+)?nord[\s-]?ouest|north[\s-]?west\s+atlantic/, 21],
  [/atlantique\s+(?:du\s+)?nord[\s-]?est|nord[\s-]?est\s+atlantique|north[\s-]?east\s+atlantic/, 27],
  [/atlantique\s+(?:du\s+)?centre[\s-]?est|eastern\s+central\s+atlantic/, 34],
  [/atlantique\s+(?:du\s+)?sud[\s-]?ouest|south[\s-]?west\s+atlantic/, 41],
  [/atlantique\s+(?:du\s+)?sud[\s-]?est|south[\s-]?east\s+atlantic/, 47],
  [/mediterranee|mer\s+noire|mediterranean|black\s+sea/, 37],
  [/ocean\s+indien\s+(?:ouest|occidental)|western\s+indian\s+ocean/, 51],
  [/ocean\s+indien\s+(?:est|oriental)|eastern\s+indian\s+ocean/, 57],
];

/**
 * Present a stored FAO value as "N Nom - Sous zone: (Roman)". Returns the verbatim value
 * when the area can't be identified, and the caller's placeholder for empty input.
 */
export function formatFaoDisplay(value: string | null | undefined): string | null | undefined {
  const raw = (value ?? '').trim();
  if (!raw) return value;
  const text = normalize(raw);

  // Major area: first number that is a real FAO area, else an official name.
  let major: number | null = null;
  for (const tok of raw.match(/\d{1,2}/g) ?? []) {
    const n = parseInt(tok, 10);
    if (AREA_NAMES[n]) {
      major = n;
      break;
    }
  }
  if (major == null) {
    for (const [re, n] of NAME_PATTERNS) {
      if (re.test(text)) {
        major = n;
        break;
      }
    }
  }
  if (major == null) return raw; // unknown area → keep verbatim, never invent

  // Sub-zone: dotted code "27.5" → 5, else "sous-zone V" / "sub-area VIII".
  let sub: number | null = null;
  const dotted = new RegExp(`\\b${major}\\.(\\d{1,2})`).exec(raw);
  if (dotted) {
    sub = parseInt(dotted[1], 10);
  } else {
    const m = /(?:sous[\s-]?zones?|sous[\s-]?secteur|sub[\s-]?area|division)\s*:?\s*\(?\s*([ivx]+|\d{1,2})/i.exec(text);
    if (m) sub = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : fromRoman(m[1]);
  }

  let out = `${major} ${AREA_NAMES[major]}`;
  if (sub != null && sub >= 1) {
    const others = /(et\s+autres|and\s+other|autres\s+sous|diverses?)/.test(text) ? ' et autres' : '';
    out += ` - Sous zone: (${toRoman(sub)}${others})`;
  }
  return out;
}
