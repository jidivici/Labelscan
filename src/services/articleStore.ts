/**
 * ArticleStore — the persistence PORT for saved articles (audit §7.2).
 *
 * Why a port: the previous implementation kept EVERY article (each embedding its full
 * `raw_extraction_run`) in ONE AsyncStorage JSON blob — an O(n) full rewrite on every
 * save and a hard ~6 MB ceiling (Android CursorWindow) → silent data loss at a few
 * thousand lots. This interface lets the storage engine be swapped without touching the
 * screens (the facade in services/storage.ts keeps the same public API).
 *
 * Adapters:
 *   - InMemoryArticleStore        — articleStoreMemory.ts (tests / reference; fully verifiable)
 *   - AsyncStorageArticleStore     — articleStoreAsyncStorage.ts (production now: one key per
 *                                    article → no blob ceiling, O(1) writes, getById O(1))
 *   - SqliteArticleStore (FUTURE)  — to use expo-sqlite in production, implement this port
 *                                    over expo-sqlite (indexed columns + FTS5 for search at
 *                                    very large scale) and inject it at app init via
 *                                    `setArticleStore(new SqliteArticleStore())` (see
 *                                    services/storage.ts). Nothing else has to change.
 *
 * Contract note: `getAll`/`getById` return LIGHT articles — `raw_extraction_run` is kept
 * OUT of the hot path (it is write-only debug data that no screen or export reads) and is
 * persisted separately by the adapter, so listing/opening never pays for it.
 */

import type { Article } from '../types/Article';

export interface ArticleStore {
  /** All saved articles, newest-first. `raw_extraction_run` is omitted (null). */
  getAll(): Promise<Article[]>;
  /** One article by id, or null. `raw_extraction_run` is omitted (null). */
  getById(id: string): Promise<Article | null>;
  /** Insert or replace an article (raw_extraction_run is persisted out of the hot path). */
  put(article: Article): Promise<void>;
  /** Remove an article (and its out-of-band raw run), idempotent. */
  remove(id: string): Promise<void>;
}

// Per-article key (light record). NOTE the trailing colon: it must NOT be a prefix of the
// raw-key prefix below, so getAll's prefix filter never picks up raw rows.
export const ARTICLE_KEY_PREFIX = '@labelscan:article:';
// Out-of-hot-path raw extraction run, one key per article (lazy / debug only).
export const ARTICLE_RAW_KEY_PREFIX = '@labelscan:articleRaw:';
// The legacy single-blob key (pre-§7.2). Read once for migration, then left as a backup.
export const LEGACY_ARTICLES_KEY = '@labelscan:articles';
// Set once the legacy blob has been migrated to per-article keys (value = ISO timestamp).
export const STORAGE_V2_FLAG = '@labelscan:storageV2Migrated';

/** Newest-first by saved_at (ISO lexical order); missing timestamps sort last. */
export function byNewestSaved(a: Article, b: Article): number {
  return (b.saved_at || '').localeCompare(a.saved_at || '');
}

/** A copy with the heavy raw run dropped — what the hot path (list/detail) stores/returns. */
export function withoutRawRun(article: Article): Article {
  return { ...article, raw_extraction_run: null };
}
