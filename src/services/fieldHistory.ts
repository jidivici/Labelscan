/**
 * fieldHistory — per-field autocomplete from the operator's OWN history (workflow v2.1).
 *
 * A criée re-enters the same species, producers and FAO areas day after day; with the
 * 17/17 save gate, retyping them is the main drag toward validation. This module builds,
 * from the SAVED articles (validated truth — never machine guesses), a per-field ranked
 * value list, and suggests up to 3 completions for the field being typed.
 *
 * Compliance stance: suggestions only surface values a human already validated on a
 * previous arrivage, and applying one is a HUMAN edit (same path as typing) — the
 * extraction no-fabrication gate is untouched. `allergens` is deliberately NOT here:
 * it keeps its dedicated EU Annexe II suggestion (allergenSuggestions.ts).
 *
 * Pure + framework-free (unit-tested without React).
 */

import { normalize } from './articleSearch';
import type { Article } from '../types/Article';

/**
 * The fields whose values recur across arrivages. Excluded: batch/dates/gtin (unique
 * per lot), weight/temperature/price (affix inputs, per-lot numerics), allergens
 * (dedicated compliance suggestion).
 */
export const HISTORY_FIELDS: readonly string[] = [
  'commercial_designation',
  'scientific_name',
  'producer_name',
  'reseller_brand',
  'production_method',
  'fishing_gear_or_farming_method',
  'FAO_area',
  'origin_country',
  'health_mark',
];

interface HistoryEntry {
  /** Display form — the casing/accents of the MOST RECENT occurrence. */
  value: string;
  /** Normalized form (dedup + match key). */
  key: string;
  count: number;
  /** ISO saved_at of the most recent occurrence (recency tiebreaker). */
  lastSavedAt: string;
}

/** Ranked distinct values per field name. Build once per article-list change. */
export type FieldHistory = ReadonlyMap<string, readonly HistoryEntry[]>;

/**
 * Build the per-field history from saved articles: values deduplicated by normalized
 * form (keeping the most recent display casing), ranked by frequency then recency.
 */
export function buildFieldHistory(articles: readonly Article[] | null | undefined): FieldHistory {
  const byField = new Map<string, Map<string, HistoryEntry>>();
  for (const name of HISTORY_FIELDS) byField.set(name, new Map());

  for (const article of articles ?? []) {
    const savedAt = article.saved_at ?? '';
    for (const f of article.fields) {
      const bucket = byField.get(f.field_name);
      if (!bucket) continue;
      const value = f.value?.trim();
      if (!value) continue;
      const key = normalize(value);
      const existing = bucket.get(key);
      if (!existing) {
        bucket.set(key, { value, key, count: 1, lastSavedAt: savedAt });
      } else {
        existing.count += 1;
        if (savedAt > existing.lastSavedAt) {
          existing.lastSavedAt = savedAt;
          existing.value = value; // most recent display form wins
        }
      }
    }
  }

  const out = new Map<string, readonly HistoryEntry[]>();
  for (const [name, bucket] of byField) {
    out.set(
      name,
      [...bucket.values()].sort(
        (a, b) => b.count - a.count || b.lastSavedAt.localeCompare(a.lastSavedAt),
      ),
    );
  }
  return out;
}

/**
 * Up to `max` suggestions for one field given the live draft:
 *  - empty draft → the top values (most frequent/recent);
 *  - otherwise, normalized PREFIX matches first, then substring matches;
 *  - a value strictly equal (normalized) to the draft is never suggested (already typed).
 * Unknown/non-history fields → [].
 */
export function suggestForField(
  history: FieldHistory,
  fieldName: string,
  draft: string,
  max = 3,
): string[] {
  const entries = history.get(fieldName);
  if (!entries || entries.length === 0) return [];
  const q = normalize(draft.trim());
  if (!q) return entries.slice(0, max).map((e) => e.value);

  const prefix: string[] = [];
  const substring: string[] = [];
  for (const e of entries) {
    if (e.key === q) continue; // already fully typed
    if (e.key.startsWith(q)) prefix.push(e.value);
    else if (e.key.includes(q)) substring.push(e.value);
    if (prefix.length >= max) break;
  }
  return [...prefix, ...substring].slice(0, max);
}
