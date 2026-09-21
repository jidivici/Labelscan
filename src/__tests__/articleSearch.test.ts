import { matchesArticle, searchArticles } from '../services/articleSearch';
import type { Article, ArticleField } from '../types/Article';

function field(field_name: string, value: string | null): ArticleField {
  return { field_name, value, combined_confidence: 1, confidence_band: 'high', validation_status: 'present' };
}

function article(partial: Partial<Article>): Article {
  return {
    id: 'a',
    source: 'backend_extraction',
    ingestion_id: 'i',
    extraction_run_id: null,
    captured_at: '2026-06-20T08:00:00.000Z',
    photo_uri: null,
    barcode_raw: null,
    ingestion_status: 'extracted',
    fields: [],
    saved_at: '2026-06-20T08:00:00.000Z',
    saved_by: null,
    ...partial,
  };
}

const cod = article({
  id: 'cod',
  fields: [
    field('product_name', 'Filet de Cabillaud'),
    field('batch_number', 'L24-0917'),
    field('FAO_area', '27'),
    field('production_method', 'wild_caught'),
  ],
});
const salmon = article({
  id: 'salmon',
  fields: [
    field('product_name', 'Saumon'),
    field('batch_number', 'L24-1200'),
    field('FAO_area', '34'),
    field('production_method', 'farmed'),
  ],
});
const list = [cod, salmon];

describe('omni-search across all labels', () => {
  it('matches by lot number', () => {
    expect(searchArticles(list, '0917').map((a) => a.id)).toEqual(['cod']);
  });

  it('matches by species, accent- and case-insensitive', () => {
    expect(searchArticles(list, 'cabillaud').map((a) => a.id)).toEqual(['cod']);
    expect(matchesArticle(cod, 'CABILLAUD')).toBe(true);
  });

  it('matches by FAO zone', () => {
    expect(searchArticles(list, '27').map((a) => a.id)).toEqual(['cod']);
  });

  it('matches the farming method via French (Élevage / Pêche sauvage)', () => {
    expect(searchArticles(list, 'élevage').map((a) => a.id)).toEqual(['salmon']);
    expect(searchArticles(list, 'sauvage').map((a) => a.id)).toEqual(['cod']);
  });

  it('ANDs multiple terms', () => {
    expect(searchArticles(list, 'saumon 34').map((a) => a.id)).toEqual(['salmon']);
    expect(searchArticles(list, 'saumon 27')).toEqual([]);
  });

  it('matches the raw barcode (GS1-128 lot)', () => {
    const bc = article({ id: 'bc', barcode_raw: '0102600 LOT-7741' });
    expect(matchesArticle(bc, '7741')).toBe(true);
  });

  it('empty query returns everything; no match returns []', () => {
    expect(searchArticles(list, '   ')).toEqual(list);
    expect(searchArticles(list, 'thon')).toEqual([]);
  });
});
