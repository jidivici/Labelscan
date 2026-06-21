/**
 * Home (Arrivages) ordering — pure + testable. The central article list is sorted by
 * the common product name (A→Z, accent/case-insensitive, fr); the registration date is
 * shown per card, so there is no date grouping.
 */

import type { Article } from '../types/Article';

/** Common (vernacular) product name — for the alphabetical sort AND the card title. */
export function commonName(article: Article): string {
  const byName = (n: string) => article.fields.find((f) => f.field_name === n)?.value ?? '';
  return (byName('commercial_designation') || byName('product_name') || '').trim();
}

/**
 * Sort by product name A→Z (accent/case-insensitive). Articles with no product name go
 * last; ties break by most-recently-saved first.
 */
export function sortArticlesByName(articles: Article[]): Article[] {
  const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
  return [...articles].sort((a, b) => {
    const an = commonName(a);
    const bn = commonName(b);
    if (an && !bn) return -1;
    if (!an && bn) return 1;
    const byName = collator.compare(an, bn);
    if (byName !== 0) return byName;
    return (b.saved_at || '').localeCompare(a.saved_at || '');
  });
}
