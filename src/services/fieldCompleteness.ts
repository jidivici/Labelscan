/**
 * Field-completeness scoring for the home screen's "En cours" cards (workflow v1).
 *
 * The backend extracts a CLOSED set of 17 fields (services/fieldOrder.ts FIELD_ORDER).
 * This module derives, from EITHER the final run's ExtractionField[] OR the Tier-3
 * interim preview (Record<field_name, value>), two presentational signals:
 *
 *  - filledCount (/17): how many of the canonical fields already carry a usable value.
 *    Rendered as plain "n/17 champs" text on the "En cours" card as OCR/LLM land.
 *  - isProductNameKnown: whether `commercial_designation` is filled. The home card
 *    keeps the "Extraction" step highlighted until the operator can see a NAME — the
 *    single most identifying field — so the wait never feels information-free.
 *
 * Pure + framework-free so it is unit-tested without React.
 */

import { fieldOrderForTrade } from './fieldOrder';
import type { ExtractionField } from '../types/api';

/** The closed field set length — the "/17" denominator shown in the UI. */
export const CANONICAL_FIELD_COUNT = fieldOrderForTrade('poissonnerie').length;

export function canonicalFieldCount(tradeCode?: string | null): number {
  return fieldOrderForTrade(tradeCode).length;
}

/** A field value counts as "filled" when it is a non-blank string. */
function isFilledValue(value: string | null | undefined): boolean {
  return value != null && value.trim() !== '';
}

/**
 * Count filled canonical fields from a FINAL extraction run's field list.
 * A field with validation_status 'missing' never counts, even if it carries a
 * stray value. Fields outside the canonical set are ignored (the /17 is closed).
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
  let count = 0;
  for (const name of fieldOrderForTrade(tradeCode)) {
    if (edits && name in edits) {
      if (isFilledValue(edits[name])) count += 1;
      continue;
    }
    const f = byName.get(name);
    if (!f) continue;
    if (f.validation_status === 'missing') continue;
    if (isFilledValue(f.value)) count += 1;
  }
  return count;
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
 * string). Used by the Review screen's 17/17 save gate (workflow v2): the map holds
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
    if (isFilledValue(values[name])) count += 1;
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
