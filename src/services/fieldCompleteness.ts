/**
 * Field-completeness scoring for the home screen's "En cours" cards (workflow v1).
 *
 * The backend extracts a closed, profile-specific V2 field set.
 * This module derives, from EITHER the final run's ExtractionField[] OR the Tier-3
 * interim preview (Record<field_name, value>), two presentational signals:
 *
 *  - filledCount: how many canonical profile fields already carry a usable value.
 *  - isProductNameKnown: whether `commercial_designation` is filled. The home card
 *    keeps the "Extraction" step highlighted until the operator can see a NAME — the
 *    single most identifying field — so the wait never feels information-free.
 *
 * Pure + framework-free so it is unit-tested without React.
 */

import { fieldOrderForTrade } from './fieldOrder';
import { allowsNotCommunicated } from './finalReviewValidation';
import type { ExtractionField, ValidationStatus } from '../types/api';

/** The active poissonnerie V2 denominator shown in the UI. */
export const CANONICAL_FIELD_COUNT = fieldOrderForTrade('poissonnerie').length;
export const NOT_COMMUNICATED_VALUE = 'NC';

/** Final catalogue values are always explicit: blank/absent means non communiqué. */
export function normalizeFinalReviewValue(
  value: string | null | undefined,
): string {
  const normalized = value?.trim() ?? '';
  return normalized.toUpperCase() === NOT_COMMUNICATED_VALUE
    ? NOT_COMMUNICATED_VALUE
    : normalized;
}

/**
 * Seed the editable HUMAN review without inventing a decision for the operator.
 *
 * A machine absence stays blank and therefore cannot count as a completed field. A
 * defensive stray value attached to `missing` is ignored too. `NC` becomes final only
 * when it was already explicit in a non-missing value or when the operator selects it
 * in the review UI.
 */
export function initialHumanReviewValue(
  value: string | null | undefined,
  validationStatus?: ValidationStatus,
): string {
  if (validationStatus === 'missing') return '';
  return normalizeFinalReviewValue(value);
}

/** Typing a single n/N explicitly offers the canonical non-communicated value. */
export function notCommunicatedSuggestion(value: string): string | null {
  return value.trim().toLowerCase() === 'n' ? NOT_COMMUNICATED_VALUE : null;
}

export function canonicalFieldCount(tradeCode?: string | null): number {
  return fieldOrderForTrade(tradeCode).length;
}

/** A field value counts as "filled" when it is a non-blank string. */
function isFilledValue(
  value: string | null | undefined,
  fieldName?: string,
  values?: Record<string, string>,
): boolean {
  if (value == null || value.trim() === '') return false;
  const farmedFaoNotApplicable =
    fieldName === 'FAO_area' &&
    value.trim().toUpperCase() === NOT_COMMUNICATED_VALUE &&
    values?.production_method != null &&
    ['farmed', 'élevage'].includes(values.production_method.trim().toLocaleLowerCase('fr-FR'));
  if (
    fieldName &&
    !allowsNotCommunicated(fieldName) &&
    value.trim().toUpperCase() === NOT_COMMUNICATED_VALUE &&
    !farmedFaoNotApplicable
  ) return false;
  return true;
}

/**
 * Count filled canonical fields from a FINAL extraction run's field list.
 * A non-empty extracted value counts immediately, even when its status still requires
 * the operator to confirm it. This deliberately mirrors the Review form's visible
 * completion score; confirmation controls save eligibility, not whether the field is
 * filled. Fields outside the canonical profile set are ignored.
 *
 * `edits` (workflow v2, optional) is the scan's persisted review draft: where a key
 * exists it OVERRIDES the run value — a typed value fills the field, a blanked draft
 * un-fills it — so the home card's gauge tracks the operator's session live.
 */
export function filledCountFromRun(
  fields: ExtractionField[] | null | undefined,
  edits?: Record<string, string>,
  tradeCode?: string | null,
): number {
  const byName = new Map<string, ExtractionField>();
  for (const f of fields ?? []) byName.set(f.field_name, f);
  const effectiveValues: Record<string, string> = {};
  for (const name of fieldOrderForTrade(tradeCode)) {
    if (edits && name in edits) {
      effectiveValues[name] = edits[name];
      continue;
    }
    const f = byName.get(name);
    if (!f) continue;
    effectiveValues[name] = initialHumanReviewValue(f.value, f.validation_status);
  }
  // The Review screen projects FAO=NC for farmed seafood because a catch area does
  // not apply. Mirror that projection on the home card so a saveable 16/16 review
  // never falls back to 15/16 after the operator returns to the list.
  if (
    (tradeCode == null || tradeCode === 'poissonnerie') &&
    ['farmed', 'élevage'].includes(
      effectiveValues.production_method?.trim().toLocaleLowerCase('fr-FR') ?? '',
    ) &&
    !effectiveValues.FAO_area?.trim()
  ) {
    effectiveValues.FAO_area = NOT_COMMUNICATED_VALUE;
  }
  return filledCountFromValues(effectiveValues, tradeCode);
}

/**
 * Count filled canonical fields from the Tier-3 interim preview (Record<field_name,
 * value>). Interim values are deterministic previews written between OCR and the LLM —
 * a field present with a blank value does not count. `edits` overlays the review draft
 * the same way as in filledCountFromRun.
 */
export function filledCountFromInterim(
  interim: Record<string, string> | null | undefined,
  edits?: Record<string, string>,
  tradeCode?: string | null,
): number {
  if (!edits) return filledCountFromValues(interim, tradeCode);
  return filledCountFromValues({ ...(interim ?? {}), ...edits }, tradeCode);
}

/**
 * Count filled canonical fields from a plain map of EFFECTIVE values (field_name →
 * string). Used by the Review screen's profile-completeness save gate: the map holds
 * each field's live draft (operator edit taking priority over the extracted value), so
 * the count reflects exactly what will be saved. A blank/whitespace value never counts.
 */
export function filledCountFromValues(
  values: Record<string, string> | null | undefined,
  tradeCode?: string | null,
): number {
  if (!values) return 0;
  let count = 0;
  for (const name of fieldOrderForTrade(tradeCode)) {
    if (isFilledValue(values[name], name, values)) count += 1;
  }
  return count;
}

/** True when the product name (commercial_designation) is already known. A review
 * draft (`edits`) overrides the extracted value, in both directions. */
export function isProductNameKnownFromRun(
  fields: ExtractionField[] | null | undefined,
  edits?: Record<string, string>,
): boolean {
  if (edits && PRODUCT_NAME_FIELD in edits) return isFilledValue(edits[PRODUCT_NAME_FIELD]);
  if (!fields) return false;
  const f = fields.find((x) => x.field_name === PRODUCT_NAME_FIELD);
  return !!f && f.validation_status !== 'missing' && isFilledValue(f.value);
}

export function isProductNameKnownFromInterim(
  interim: Record<string, string> | null | undefined,
  edits?: Record<string, string>,
): boolean {
  if (edits && PRODUCT_NAME_FIELD in edits) return isFilledValue(edits[PRODUCT_NAME_FIELD]);
  return isFilledValue(interim?.commercial_designation);
}

/** The canonical field name used as the "name known" probe (exported for tests/UI). */
export const PRODUCT_NAME_FIELD = 'commercial_designation';
