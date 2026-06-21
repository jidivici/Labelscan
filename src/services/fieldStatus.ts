/**
 * Field uncertainty — the single rule that decides whether a DISPLAYED value gets the
 * discreet "à vérifier" tag. Replaces the per-field confidence percentages: the operator
 * doesn't need a number, only a flag when the extracted answer is shaky.
 *
 * A present value is "uncertain" when its validation_status is ambiguous/invalid/
 * unnormalizable, OR its combined confidence is below 70%. An empty value is NOT
 * "uncertain" (it's simply missing → handled separately as "à compléter").
 */

export const UNCERTAIN_BELOW = 0.7;

export interface FieldLike {
  value: string | null;
  combined_confidence: number;
  validation_status: string;
}

const SHAKY_STATUS = new Set(['ambiguous', 'invalid', 'unnormalizable']);

export function isUncertain(field: FieldLike): boolean {
  if (field.value == null || field.value === '') return false;
  if (SHAKY_STATUS.has(field.validation_status)) return true;
  return typeof field.combined_confidence === 'number' && field.combined_confidence < UNCERTAIN_BELOW;
}
