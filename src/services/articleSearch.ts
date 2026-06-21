/**
 * Omni-search for the Articles list — matches a saved article across ALL of its
 * extracted fields (lot, espèce, zone FAO, méthode d'élevage, fournisseur…) plus the
 * raw barcode. Pure, accent/case-insensitive, multi-term (AND), so the same logic is
 * testable and reused by the `useArticleSearch` hook.
 */

import type { Article } from '../types/Article';
import { productionMethodFr } from './fieldLabels';

/** Lowercase + strip NFD combining accents (so "cabillaud" matches "Cabillaud"). */
function normalize(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase().normalize('NFD')) {
    const c = ch.charCodeAt(0);
    if (c >= 0x300 && c <= 0x36f) continue; // combining diacritics
    out += ch;
  }
  return out;
}

/** Every searchable token of one article: all field values (+ the French production
 *  method so "élevage"/"sauvage" match the English controlled vocab) + the barcode. */
function haystack(article: Article): string {
  const parts: string[] = [];
  for (const f of article.fields) {
    if (f.value) parts.push(f.value);
    if (f.field_name === 'production_method') {
      const fr = productionMethodFr(f.value);
      if (fr) parts.push(fr);
    }
  }
  if (article.barcode_raw) parts.push(article.barcode_raw);
  return normalize(parts.join(' '));
}

/** Single matching rule: TRUE when EVERY whitespace-separated term of an
 *  already-normalized query is found in an already-normalized haystack. Shared by the
 *  per-article and the indexed paths so there is one source of truth for "matches". */
function hayMatchesQuery(hay: string, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return normalizedQuery.split(/\s+/).every((term) => hay.includes(term));
}

/** True when EVERY whitespace-separated term is found somewhere in the article. */
export function matchesArticle(article: Article, query: string): boolean {
  return hayMatchesQuery(haystack(article), normalize(query.trim()));
}

/** Filter the list with the omni-search; an empty query returns it unchanged. */
export function searchArticles(articles: Article[], query: string): Article[] {
  if (!query.trim()) return articles;
  const q = normalize(query.trim());
  return articles.filter((a) => hayMatchesQuery(haystack(a), q));
}

// ── Indexed path (large lists) ───────────────────────────────────────────────────
// `searchArticles` rebuilds + re-normalizes every article's haystack on each call, so
// calling it on every keystroke is O(n × label length) per key. For 5000+ saved lots
// that re-normalization is the cost that makes typing janky. Build the haystack ONCE
// per list change (buildSearchIndex), then each keystroke is just cheap substring
// checks against the precomputed strings (searchIndex). Used by useArticleSearch.

export interface SearchEntry {
  article: Article;
  /** Precomputed normalized haystack — built once, reused across every keystroke. */
  hay: string;
}

/** Precompute the normalized haystack for every article. Call when the list changes,
 *  NOT on every keystroke. */
export function buildSearchIndex(articles: Article[]): SearchEntry[] {
  return articles.map((article) => ({ article, hay: haystack(article) }));
}

/** Filter a precomputed index; an empty query returns every article (order preserved). */
export function searchIndex(index: SearchEntry[], query: string): Article[] {
  const q = normalize(query.trim());
  if (!q) return index.map((e) => e.article);
  return index.filter((e) => hayMatchesQuery(e.hay, q)).map((e) => e.article);
}
