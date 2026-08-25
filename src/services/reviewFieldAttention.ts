import type { ValidationStatus } from '../types/api';

const QUESTIONABLE_STATUSES = new Set<ValidationStatus>([
  'ambiguous',
  'unnormalizable',
  'invalid',
]);

/** A human non-empty edit always clears the machine attention treatment. */
export function shouldHighlightReviewField(
  draft: string,
  validationStatus: ValidationStatus,
  edited: boolean,
): boolean {
  if (draft.trim() === '') return true;
  return !edited && QUESTIONABLE_STATUSES.has(validationStatus);
}
