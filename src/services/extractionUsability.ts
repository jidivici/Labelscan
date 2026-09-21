/**
 * Safety gate between a completed server extraction and the human review flow.
 *
 * A terminal run is reviewable only when it contains at least one usable value from
 * the authenticated business profile's closed field contract. This prevents an empty,
 * garbage or off-contract model response from becoming a blank form that an operator
 * could accidentally turn into a seemingly valid arrival.
 */

import { fieldOrderForTrade } from './fieldOrder';
import type { ExtractionField } from '../types/api';

export const RECAPTURE_TITLE = 'Photo à reprendre';
export const RECAPTURE_MESSAGE =
  'Aucune information exploitable n’a été détectée. La photo ne correspond pas à une étiquette lisible ou complète.';
export const RECAPTURE_GUIDANCE =
  'Cadrez toute l’étiquette, évitez les reflets et reprenez la photo.';

const NON_USABLE_STATUSES = new Set<ExtractionField['validation_status']>([
  'missing',
  'invalid',
  'unnormalizable',
]);

/**
 * True only for a non-empty canonical value that is suitable as evidence that the
 * captured image is a label. `NC` is a human review value, never extraction evidence.
 */
export function isExploitableExtractionField(
  field: ExtractionField,
  tradeCode?: string | null,
): boolean {
  const value = field.value?.trim() ?? '';
  return (
    fieldOrderForTrade(tradeCode).includes(field.field_name) &&
    value.length > 0 &&
    value.toUpperCase() !== 'NC' &&
    !NON_USABLE_STATUSES.has(field.validation_status)
  );
}

/** A completed run with no usable canonical field must be recaptured, not reviewed. */
export function hasExploitableExtraction(
  fields: readonly ExtractionField[] | null | undefined,
  tradeCode?: string | null,
): boolean {
  return (fields ?? []).some((field) => isExploitableExtractionField(field, tradeCode));
}
