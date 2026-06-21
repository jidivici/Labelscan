/**
 * AsyncStorageArticleStore — production ArticleStore, ONE key per article (audit §7.2).
 *
 * Replaces the single-blob storage. Per-article keys mean:
 *   - no ~6 MB ceiling: the Android CursorWindow limit is per row/key, and each article
 *     key is a few KB (the heavy raw_extraction_run lives under its OWN key, off the hot
 *     path), so the blob that used to grow past the limit and silently fail is gone;
 *   - O(1) writes: a save writes only that article's two keys — no rewrite of every
 *     other article;
 *   - O(1) reads by id; listing reads only the LIGHT per-article keys (never the raw runs).
 *
 * Migration: on first use we copy the legacy single blob into per-article keys, set a
 * one-shot flag, and KEEP the old blob as a backup (a later cleanup can purge it) — no
 * data is lost. Idempotent: it runs at most once.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Article } from '../types/Article';
import type { ExtractionRunResponse } from '../types/api';
import {
  ARTICLE_KEY_PREFIX,
  ARTICLE_RAW_KEY_PREFIX,
  LEGACY_ARTICLES_KEY,
  STORAGE_V2_FLAG,
  type ArticleStore,
  byNewestSaved,
  withoutRawRun,
} from './articleStore';

const articleKey = (id: string) => `${ARTICLE_KEY_PREFIX}${id}`;
const rawKey = (id: string) => `${ARTICLE_RAW_KEY_PREFIX}${id}`;

function parseArticle(value: string | null): Article | null {
  if (!value) return null;
  try {
    const a = JSON.parse(value);
    // Ignore anything that isn't a backend-extraction record (forward/back compat).
    return a && a.source === 'backend_extraction' ? (a as Article) : null;
  } catch {
    return null;
  }
}

export class AsyncStorageArticleStore implements ArticleStore {
  private migrated = false;

  /** Run the legacy-blob migration at most once, before any read/write. */
  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return;
    if (await AsyncStorage.getItem(STORAGE_V2_FLAG)) {
      this.migrated = true;
      return;
    }
    await this.migrateLegacyBlob();
    await AsyncStorage.setItem(STORAGE_V2_FLAG, new Date().toISOString());
    this.migrated = true;
  }

  private async migrateLegacyBlob(): Promise<void> {
    const raw = await AsyncStorage.getItem(LEGACY_ARTICLES_KEY);
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt legacy blob — nothing safe to migrate
    }
    if (!Array.isArray(parsed)) return;

    const pairs: [string, string][] = [];
    for (const a of parsed) {
      if (!a || a.source !== 'backend_extraction' || typeof a.id !== 'string') continue;
      pairs.push([articleKey(a.id), JSON.stringify(withoutRawRun(a as Article))]);
      pairs.push([rawKey(a.id), JSON.stringify((a as Article).raw_extraction_run ?? null)]);
    }
    if (pairs.length > 0) await AsyncStorage.multiSet(pairs);
    // The legacy blob is intentionally LEFT in place as a backup (no data destroyed).
  }

  async getAll(): Promise<Article[]> {
    await this.ensureMigrated();
    const keys = (await AsyncStorage.getAllKeys()).filter((k) =>
      k.startsWith(ARTICLE_KEY_PREFIX),
    );
    if (keys.length === 0) return [];
    const entries = await AsyncStorage.multiGet(keys);
    const out: Article[] = [];
    for (const [, value] of entries) {
      const article = parseArticle(value);
      if (article) out.push(article);
    }
    return out.sort(byNewestSaved);
  }

  async getById(id: string): Promise<Article | null> {
    await this.ensureMigrated();
    return parseArticle(await AsyncStorage.getItem(articleKey(id)));
  }

  async put(article: Article): Promise<void> {
    await this.ensureMigrated();
    // Two independent keys: a small LIGHT record on the hot path + the heavy raw run
    // off it. No other article's data is read or rewritten (O(1)).
    await AsyncStorage.multiSet([
      [articleKey(article.id), JSON.stringify(withoutRawRun(article))],
      [rawKey(article.id), JSON.stringify(article.raw_extraction_run ?? null)],
    ]);
  }

  async remove(id: string): Promise<void> {
    await this.ensureMigrated();
    await AsyncStorage.multiRemove([articleKey(id), rawKey(id)]);
  }

  /** Lazy access to the out-of-hot-path raw run (debug). */
  async getRawRun(id: string): Promise<ExtractionRunResponse | null> {
    const value = await AsyncStorage.getItem(rawKey(id));
    if (!value) return null;
    try {
      return JSON.parse(value) as ExtractionRunResponse | null;
    } catch {
      return null;
    }
  }
}
