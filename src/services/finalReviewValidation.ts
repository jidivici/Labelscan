/** Client-side mirror of the backend's versioned FieldSpec review contract. */

type FieldKind =
  | 'text'
  | 'date'
  | 'decimal_unit'
  | 'temperature_range'
  | 'enum'
  | 'gtin'
  | 'health_mark'
  | 'fao_area'
  | 'country';

interface MobileFieldSpec {
  kind: FieldKind;
  maxLength: number;
}

const DEFAULT_SPEC: MobileFieldSpec = { kind: 'text', maxLength: 512 };
const FIELD_SPECS: Readonly<Record<string, MobileFieldSpec>> = {
  expiry_date: { kind: 'date', maxLength: 10 },
  packaging_date: { kind: 'date', maxLength: 10 },
  preparation_date: { kind: 'date', maxLength: 10 },
  weight: { kind: 'decimal_unit', maxLength: 32 },
  storage_temperature: { kind: 'temperature_range', maxLength: 40 },
  production_method: { kind: 'enum', maxLength: 32 },
  gtin: { kind: 'gtin', maxLength: 14 },
  health_mark: { kind: 'health_mark', maxLength: 64 },
  FAO_area: { kind: 'fao_area', maxLength: 120 },
  origin_country: { kind: 'country', maxLength: 80 },
  birth_country: { kind: 'country', maxLength: 80 },
  rearing_country: { kind: 'country', maxLength: 80 },
  slaughter_country: { kind: 'country', maxLength: 80 },
  cutting_country: { kind: 'country', maxLength: 80 },
};

const GTIN_LENGTHS = new Set([8, 12, 13, 14]);
const PRODUCTION_METHODS = new Set(['wild_caught', 'farmed']);
const VALUE_REQUIRED_FIELDS = new Set([
  'commercial_designation',
  'expiry_date',
  'packaging_date',
  'FAO_area',
  'origin_country',
  'health_mark',
  'batch_number',
  'production_method',
  'storage_temperature',
]);
const WEIGHT = /^(\d+(?:[.,]\d{1,3})?)\s*(g|kg)$/i;
const TEMPERATURE = /^(?:(<=|>=|≤|≥)\s*)?(-?\d+(?:[.,]\d+)?)(?:\s*(?:-|–|à)\s*(-?\d+(?:[.,]\d+)?))?\s*°?C$/i;
const HEALTH_MARK = /^[A-Z]{2}[ A-Z0-9.\-/]{1,61}$/;
// Mirror Python's Unicode-aware `[^\W_]` FAO contract: the printed designation may
// contain words (including accents), digits and the limited regulatory punctuation.
const FAO_AREA = /^[\p{L}\p{N}](?:[\p{L}\p{N}]|[ .,/()'\-]){0,119}$/u;
const COUNTRY = /^\p{L}[\p{L}\p{N}_ .\-'’]{0,79}$/u;
const BIDI_CONTROLS = new Set([
  '\u061c',
  '\u200e',
  '\u200f',
  '\u202a',
  '\u202b',
  '\u202c',
  '\u202d',
  '\u202e',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
]);
const FORBIDDEN_UNICODE_CATEGORY = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export interface FinalReviewValidationError {
  fieldName: string;
  message: string;
}

/** Regulatory/traceability fields for which the mobile workflow must collect a value. */
export function allowsNotCommunicated(fieldName: string): boolean {
  return !VALUE_REQUIRED_FIELDS.has(fieldName);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function hasForbiddenControl(value: string): boolean {
  for (const character of value) {
    if (BIDI_CONTROLS.has(character)) return true;
    // The backend permits ordinary multiline form text, but no other Cc/Cf/Cs.
    if (character === '\n' || character === '\r' || character === '\t') continue;
    if (FORBIDDEN_UNICODE_CATEGORY.test(character)) return true;
  }
  return false;
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidGtin(value: string): boolean {
  // The Code 128 symbol checksum already protects the exact scanned payload. Some
  // supplier labels carry a non-standard AI (01) check digit; keep the printed value
  // instead of forcing the operator to "correct" trusted barcode data.
  return GTIN_LENGTHS.has(value.length) && /^[0-9]+$/.test(value);
}

/**
 * Apply the same non-lossy canonicalization as the backend boundary. Validation is
 * still required afterwards: this function deliberately does not repair bad input.
 */
export function canonicalizeFinalReviewValue(
  fieldName: string,
  rawValue: string | null | undefined,
): string {
  let value = (rawValue ?? '').normalize('NFC').trim();
  if (value.toUpperCase() === 'NC') return 'NC';
  if (fieldName === 'production_method') {
    const localized = value.toLocaleLowerCase('fr-FR');
    if (localized === 'pêche sauvage') value = 'wild_caught';
    if (localized === 'élevage') value = 'farmed';
  }
  if (fieldName === 'allergens') {
    value = value
      .split(/[\r\n]+/)
      .map((part) => part.trim().replace(/^[-•]\s*/, ''))
      .filter(Boolean)
      .join(', ')
      .replace(/[ \t]+/g, ' ');
  }
  if (fieldName === 'weight') {
    const match = WEIGHT.exec(value);
    if (match) value = `${match[1].replace(',', '.')} ${match[2].toLowerCase()}`;
  }
  return value;
}

/**
 * Values must form the complete profile; blank values are therefore rejected and
 * must be explicitly marked NC. Return every field the API would reject so the
 * operator can correct the form before an outbox operation is created.
 */
export function validateFinalReviewValues(
  values: Record<string, string | null>,
): FinalReviewValidationError[] {
  const errors: FinalReviewValidationError[] = [];
  for (const [fieldName, rawValue] of Object.entries(values)) {
    const value = canonicalizeFinalReviewValue(fieldName, rawValue);
    const spec = FIELD_SPECS[fieldName] ?? DEFAULT_SPEC;
    if (!value) {
      errors.push({
        fieldName,
        message: allowsNotCommunicated(fieldName)
          ? 'Ce champ doit être renseigné ou marqué NC.'
          : 'Une valeur est obligatoire pour ce champ.',
      });
      continue;
    }
    if (codePointLength(value) > spec.maxLength) {
      errors.push({
        fieldName,
        message: `Ce champ est limité à ${spec.maxLength} caractères.`,
      });
      continue;
    }
    if (hasForbiddenControl(value)) {
      errors.push({
        fieldName,
        message: 'Ce champ contient un caractère de contrôle interdit.',
      });
      continue;
    }
    if (value === 'NC') {
      if (!allowsNotCommunicated(fieldName)) {
        errors.push({ fieldName, message: 'La valeur NC n’est pas autorisée pour ce champ.' });
      }
      continue;
    }

    if (spec.kind === 'date' && !validIsoDate(value)) {
      errors.push({ fieldName, message: 'Saisissez une date complète au format JJ/MM/AAAA.' });
    } else if (spec.kind === 'enum' && !PRODUCTION_METHODS.has(value)) {
      errors.push({ fieldName, message: 'Choisissez Pêche sauvage ou Élevage.' });
    } else if (spec.kind === 'gtin' && !isValidGtin(value)) {
      errors.push({
        fieldName,
        message: 'Le GTIN doit contenir 8, 12, 13 ou 14 chiffres, ou être NC.',
      });
    } else if (spec.kind === 'decimal_unit') {
      const match = WEIGHT.exec(value);
      if (!match || Number(match[1].replace(',', '.')) <= 0) {
        errors.push({ fieldName, message: 'Saisissez un poids positif suivi de g ou kg.' });
      }
    } else if (spec.kind === 'temperature_range') {
      const match = TEMPERATURE.exec(value);
      const first = match ? Number(match[2].replace(',', '.')) : Number.NaN;
      const second = match?.[3] == null ? null : Number(match[3].replace(',', '.'));
      if (
        !match ||
        !Number.isFinite(first) ||
        first < -100 ||
        first > 60 ||
        (second != null && (!Number.isFinite(second) || second < -100 || second > 60)) ||
        (second != null && first > second)
      ) {
        errors.push({
          fieldName,
          message: 'Saisissez une température ou une plage Celsius valide (−100 à 60 °C).',
        });
      }
    } else if (spec.kind === 'health_mark' && !HEALTH_MARK.test(value.toUpperCase())) {
      errors.push({ fieldName, message: "L’estampille sanitaire n’est pas valide." });
    } else if (spec.kind === 'fao_area' && !FAO_AREA.test(value.toUpperCase())) {
      errors.push({ fieldName, message: 'La zone FAO n’est pas valide.' });
    } else if (spec.kind === 'country' && !COUNTRY.test(value)) {
      errors.push({ fieldName, message: 'Le pays n’est pas valide.' });
    }
  }
  return errors;
}
