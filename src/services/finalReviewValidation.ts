/** Client-side mirror of the backend's strict final-review value contract. */

const DATE_FIELDS = new Set(['expiry_date', 'packaging_date', 'preparation_date']);
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

export interface FinalReviewValidationError {
  fieldName: string;
  message: string;
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  if (match[3] == null) return true;
  const day = Number(match[3]);
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidGtin(value: string): boolean {
  return GTIN_LENGTHS.has(value.length) && /^\d+$/.test(value);
}

/**
 * Values have already been normalized for submission (dates converted to ISO and
 * the explicit "NC" marker canonicalized). Return every field the API would reject
 * with VALIDATION_ERROR so the operator can correct it before creating an outbox op.
 */
export function validateFinalReviewValues(
  values: Record<string, string | null>,
): FinalReviewValidationError[] {
  const errors: FinalReviewValidationError[] = [];
  for (const [fieldName, rawValue] of Object.entries(values)) {
    const value = rawValue?.trim() ?? '';
    if (!value) {
      errors.push({ fieldName, message: 'Ce champ doit être renseigné ou marqué NC.' });
      continue;
    }
    if (value.toUpperCase() === 'NC') continue;
    if (DATE_FIELDS.has(fieldName) && !validIsoDate(value)) {
      errors.push({ fieldName, message: 'Saisissez une date complète au format JJ/MM/AAAA.' });
    } else if (
      fieldName === 'production_method' &&
      value !== 'wild_caught' &&
      value !== 'farmed'
    ) {
      errors.push({ fieldName, message: 'Choisissez Pêche sauvage, Élevage ou NC.' });
    } else if (fieldName === 'gtin' && !isValidGtin(value)) {
      errors.push({ fieldName, message: 'Le GTIN doit comporter 8, 12, 13 ou 14 chiffres, ou être NC.' });
    }
  }
  return errors;
}
