import { commonName, sortArticlesByName } from '../services/articleGrouping';
import type { Article, ArticleField } from '../types/Article';

function field(field_name: string, value: string | null): ArticleField {
  return { field_name, value, combined_confidence: 1, confidence_band: 'high', validation_status: 'present' };
}

function article(id: string, savedAt: string, fields: ArticleField[]): Article {
  return {
    id,
    source: 'backend_extraction',
    ingestion_id: 'i',
    extraction_run_id: null,
    captured_at: savedAt,
    photo_uri: null,
    barcode_raw: null,
    ingestion_status: 'extracted',
    fields,
    saved_at: savedAt,
    saved_by: null,
  };
}

describe('commonName', () => {
  it('prefers commercial_designation, then product_name', () => {
    expect(commonName(article('a', '2026-06-20T00:00:00Z', [
      field('commercial_designation', 'Cabillaud'),
      field('product_name', 'Filet de cabillaud'),
    ]))).toBe('Cabillaud');
    expect(commonName(article('b', '2026-06-20T00:00:00Z', [
      field('product_name', 'Filet de cabillaud'),
    ]))).toBe('Filet de cabillaud');
  });
});

describe('sortArticlesByName', () => {
  it('sorts by product name A→Z, accent- and case-insensitive', () => {
    const list = [
      article('sole', '2026-06-20T00:00:00Z', [field('commercial_designation', 'Sole')]),
      article('cab', '2026-06-20T00:00:00Z', [field('commercial_designation', 'cabillaud')]),
      article('dor', '2026-06-20T00:00:00Z', [field('commercial_designation', 'Dorade')]),
      article('egl', '2026-06-20T00:00:00Z', [field('commercial_designation', 'Église')]),
    ];
    expect(sortArticlesByName(list).map((a) => a.id)).toEqual(['cab', 'dor', 'egl', 'sole']);
  });

  it('puts articles without a product name last', () => {
    const list = [
      article('none', '2026-06-20T00:00:00Z', []),
      article('bar', '2026-06-20T00:00:00Z', [field('commercial_designation', 'Bar')]),
    ];
    expect(sortArticlesByName(list).map((a) => a.id)).toEqual(['bar', 'none']);
  });

  it('ties (same name) break by most-recently-saved first', () => {
    const list = [
      article('old', '2026-06-19T00:00:00Z', [field('commercial_designation', 'Thon')]),
      article('new', '2026-06-20T00:00:00Z', [field('commercial_designation', 'Thon')]),
    ];
    expect(sortArticlesByName(list).map((a) => a.id)).toEqual(['new', 'old']);
  });

  it('does not mutate the input array', () => {
    const list = [
      article('b', '2026-06-20T00:00:00Z', [field('commercial_designation', 'B')]),
      article('a', '2026-06-20T00:00:00Z', [field('commercial_designation', 'A')]),
    ];
    const copy = [...list];
    sortArticlesByName(list);
    expect(list).toEqual(copy);
  });
});
