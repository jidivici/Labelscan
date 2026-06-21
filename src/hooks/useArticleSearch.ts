/**
 * useArticleSearch — omni-search state for the Articles list.
 *
 * Type anything (numéro de lot, espèce, zone FAO, méthode d'élevage, fournisseur…) and
 * get instant cross-field filtering. The matching logic lives in services/articleSearch
 * (pure + tested); this hook only owns the query state and the memoized results.
 */

import { useDeferredValue, useMemo, useState } from 'react';

import type { Article } from '../types/Article';
import { buildSearchIndex, searchIndex } from '../services/articleSearch';

export interface UseArticleSearch {
  query: string;
  setQuery: (q: string) => void;
  results: Article[];
}

export function useArticleSearch(articles: Article[]): UseArticleSearch {
  const [query, setQuery] = useState('');
  // Precompute each article's searchable haystack ONCE per list change — not per
  // keystroke. At 5000+ lots this is the difference between re-normalizing every
  // article on every key and a handful of substring checks.
  const index = useMemo(() => buildSearchIndex(articles), [articles]);
  // Keep `query` immediate so the controlled TextInput never lags, but run the actual
  // filtering against a DEFERRED copy: under a burst of fast typing React keeps the
  // input responsive and recomputes results once typing settles (the React-19 native
  // equivalent of debouncing the filter, with no timer to own or leak).
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => searchIndex(index, deferredQuery), [index, deferredQuery]);
  return { query, setQuery, results };
}
