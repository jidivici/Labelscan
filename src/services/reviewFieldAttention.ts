import type { ValidationStatus } from '../types/api';

const QUESTIONABLE_STATUSES = new Set<ValidationStatus>([
  'missing',
  'ambiguous',
  'unnormalizable',
  'invalid',
]);

/** Machine states that need an explicit human decision before final review. */
export function requiresExplicitHumanConfirmation(
  validationStatus: ValidationStatus,
  source?: string | null,
): boolean {
  if (source === 'gs1') return false;
  return QUESTIONABLE_STATUSES.has(validationStatus);
}

/** A human non-empty edit always clears the machine attention treatment. */
export function shouldHighlightReviewField(
  draft: string,
  validationStatus: ValidationStatus,
  edited: boolean,
  source?: string | null,
): boolean {
  if (draft.trim() === '') return true;
  return !edited && requiresExplicitHumanConfirmation(validationStatus, source);
}
