/**
 * InMemoryArticleStore — an ArticleStore that keeps everything in process memory.
 *
 * Fully deterministic and dependency-free, so the storage CONTRACT is unit-testable
 * without a device, a native module, or AsyncStorage. It is also a faithful reference
 * for the persistent adapters: same hot-path semantics (raw_extraction_run kept out of
 * getAll/getById). Not used in production (state is lost on reload).
 */

import type { Article } from '../types/Article';
import type { ExtractionRunResponse } from '../types/api';
import { type ArticleStore, byNewestSaved, withoutRawRun } from './articleStore';

export class InMemoryArticleStore implements ArticleStore {
  private readonly articles = new Map<string, Article>(); // light records
  private readonly raws = new Map<string, ExtractionRunResponse | null>(); // out-of-hot-path

  async getAll(): Promise<Article[]> {
    return [...this.articles.values()].sort(byNewestSaved);
  }

  async getById(id: string): Promise<Article | null> {
    return this.articles.get(id) ?? null;
  }

  async put(article: Article): Promise<void> {
    this.raws.set(article.id, article.raw_extraction_run ?? null);
    this.articles.set(article.id, withoutRawRun(article));
  }

  async remove(id: string): Promise<void> {
    this.articles.delete(id);
    this.raws.delete(id);
  }

  /** Lazy access to the out-of-hot-path raw run (debug). Not part of the hot path. */
  async getRawRun(id: string): Promise<ExtractionRunResponse | null> {
    return this.raws.get(id) ?? null;
  }
}
