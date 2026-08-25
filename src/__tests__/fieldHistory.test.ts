/**
 * fieldHistory — per-field autocomplete from saved articles (workflow v2.1).
 * Pure, framework-free: build (normalized dedup, most-recent casing, frequency>recency
 * ranking) + suggest (top-N on empty draft, prefix>substring, exact value excluded).
 */

import { buildFieldHistory, suggestForField, HISTORY_FIELDS } from '../services/fieldHistory';
import type { Article, ArticleField } from '../types/Article';

function article(savedAt: string, values: Record<string, string | null>): Article {
  const fields: ArticleField[] = Object.entries(values).map(([field_name, value]) => ({
    field_name,
    value,
    combined_confidence: 0.9,
    confidence_band: 'high',
    validation_status: value ? 'present' : 'missing',
  }));
  return {
    id: `a-${savedAt}`,
    saved_at: savedAt,
    captured_at: savedAt,
    photo_uri: null,
    barcode_raw: null,
    ingestion_id: 'ing',
    extraction_run_id: 'run',
    ingestion_status: 'confirmed',
    saved_by: 'op',
    fields,
  } as unknown as Article;
}

describe('fieldHistory', () => {
  it('HISTORY_FIELDS covers the recurring text fields and excludes per-lot/compliance ones', () => {
    expect(HISTORY_FIELDS).toContain('commercial_designation');
    expect(HISTORY_FIELDS).toContain('producer_name');
    expect(HISTORY_FIELDS).toContain('FAO_area');
    for (const excluded of ['batch_number', 'expiry_date', 'gtin', 'weight', 'allergens']) {
      expect(HISTORY_FIELDS).not.toContain(excluded);
    }
  });

  it('dedups by normalized form, keeps the most recent casing, ranks frequency then recency', () => {
    const history = buildFieldHistory([
      article('2026-07-01T10:00:00Z', { commercial_designation: 'cabillaud' }),
      article('2026-07-03T10:00:00Z', { commercial_designation: 'Cabillaud' }), // same value, newer casing
      article('2026-07-02T10:00:00Z', { commercial_designation: 'Lieu noir' }),
      article('2026-07-04T10:00:00Z', { commercial_designation: 'Merlu' }),
    ]);
    // cabillaud ×2 first (freq), then Merlu (more recent) before Lieu noir.
    expect(suggestForField(history, 'commercial_designation', '')).toEqual([
      'Cabillaud',
      'Merlu',
      'Lieu noir',
    ]);
  });

  it('suggests prefix matches before substring matches, accent/case-insensitive', () => {
    const history = buildFieldHistory([
      article('2026-07-01T10:00:00Z', { producer_name: 'Pêcherie Océane' }),
      article('2026-07-02T10:00:00Z', { producer_name: 'Océan Direct' }),
      article('2026-07-03T10:00:00Z', { producer_name: 'Mareyage Sud' }),
    ]);
    // "oce" → prefix "Océan Direct" first, substring "Pêcherie Océane" second.
    expect(suggestForField(history, 'producer_name', 'oce')).toEqual([
      'Océan Direct',
      'Pêcherie Océane',
    ]);
  });

  it('never suggests the exact value already typed, and respects max', () => {
    const history = buildFieldHistory([
      article('2026-07-01T10:00:00Z', { FAO_area: '27.8.b.1' }),
      article('2026-07-02T10:00:00Z', { FAO_area: '27.8.b.2' }),
      article('2026-07-03T10:00:00Z', { FAO_area: '27.7.a' }),
      article('2026-07-04T10:00:00Z', { FAO_area: '37.1.1' }),
    ]);
    // Prefix "27.8" completes to both sub-areas; the exact already-typed value is
    // excluded, so a fully-typed draft with siblings still offers the OTHER one.
    expect(suggestForField(history, 'FAO_area', '27.8')).toEqual(['27.8.b.2', '27.8.b.1']);
    expect(suggestForField(history, 'FAO_area', '27.7.a')).toEqual([]);
    expect(suggestForField(history, 'FAO_area', '', 2)).toHaveLength(2);
  });

  it('returns [] for non-history fields, unknown fields, blank values and empty input', () => {
    const history = buildFieldHistory([
      article('2026-07-01T10:00:00Z', { batch_number: 'LOT-1', scientific_name: '   ' }),
    ]);
    expect(suggestForField(history, 'batch_number', '')).toEqual([]);
    expect(suggestForField(history, 'scientific_name', '')).toEqual([]);
    expect(suggestForField(history, 'does_not_exist', '')).toEqual([]);
    expect(suggestForField(buildFieldHistory(null), 'producer_name', '')).toEqual([]);
    expect(suggestForField(buildFieldHistory([]), 'producer_name', '')).toEqual([]);
  });

  it('no match → no chips (never fabricates)', () => {
    const history = buildFieldHistory([
      article('2026-07-01T10:00:00Z', { origin_country: 'France' }),
    ]);
    expect(suggestForField(history, 'origin_country', 'Norvège')).toEqual([]);
  });
});
