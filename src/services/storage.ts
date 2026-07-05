/**
 * Storage Service — backend-extraction articles (facade).
 *
 * Public API unchanged (getAllArticles / getArticleById / saveBackendArticle /
 * deleteArticle) so the screens don't move. Record persistence is delegated to an
 * ArticleStore PORT (audit §7.2): the default is the per-key AsyncStorage adapter — no
 * 6 MB blob ceiling, O(1) writes. To run on expo-sqlite in production, implement the port
 * and call setArticleStore(new SqliteArticleStore()) at app init; nothing here changes.
 *
 * This facade still owns the PHOTO lifecycle (cache → permanent documents dir), which is
 * orthogonal to where the record is stored.
 */

import 'react-native-get-random-values'; // crypto polyfill for uuid (also imported in App.tsx)
import { v4 as uuidv4 } from 'uuid';

import * as FileSystem from 'expo-file-system/legacy';

import { Article, ArticleField } from '../types/Article';
import type { ExtractionRunResponse } from '../types/api';
import type { ArticleStore } from './articleStore';
import { AsyncStorageArticleStore } from './articleStoreAsyncStorage';

const PHOTOS_DIR = `${FileSystem.documentDirectory}photos/`;

// The active persistence engine. Default = per-key AsyncStorage (§7.2). SWAP POINT for a
// future SqliteArticleStore (expo-sqlite, indexed + FTS5): inject it once at app init.
let store: ArticleStore = new AsyncStorageArticleStore();

/** Replace the storage engine (e.g. inject SqliteArticleStore in prod, a fake in tests). */
export function setArticleStore(next: ArticleStore): void {
  store = next;
}

// ─── Ensure photos dir exists ────────────────────────────────────────────────

async function ensurePhotosDirExists(): Promise<void> {
  const dirInfo = await FileSystem.getInfoAsync(PHOTOS_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(PHOTOS_DIR, { intermediates: true });
  }
}

// ─── Reads (delegated to the active store) ──────────────────────────────────────

export async function getAllArticles(): Promise<Article[]> {
  return store.getAll();
}

export async function getArticleById(id: string): Promise<Article | null> {
  return store.getById(id);
}

// ─── Save a backend-extraction article ──────────────────────────────────────────

export interface SaveBackendArticleInput {
  ingestion_id: string;
  extraction_run_id: string | null;
  captured_at: string;
  tempPhotoUri?: string; // cache uri to move into permanent storage
  barcode_raw?: string | null;
  ingestion_status: string;
  fields: ArticleField[];
  saved_by?: string | null; // signed-in user who saved this record
  raw_extraction_run?: ExtractionRunResponse | null;
}

export async function saveBackendArticle(input: SaveBackendArticleInput): Promise<Article> {
  const id = uuidv4();

  // Persist the captured photo into permanent storage.
  //  - COPY, not move: the temp file is also the image shown in Review and the one
  //    uploaded for extraction; moving it out from under those was fragile. The OS
  //    purges the cache copy later.
  //  - Fixed ".jpg" extension: the capture+crop pipeline always emits JPEG. Deriving
  //    the extension from the cache URI (split('.').pop()) was unreliable —
  //    ImageManipulator cache URIs are not guaranteed to end in ".jpg", which produced
  //    a malformed destination path and a silent persistence failure (lost photo).
  let photoUri: string | null = null;
  if (input.tempPhotoUri) {
    try {
      await ensurePhotosDirExists();
      const src = await FileSystem.getInfoAsync(input.tempPhotoUri);
      if (!src.exists) {
        console.warn('Photo source missing at save time; saving without photo:', input.tempPhotoUri);
      } else {
        const permanentPath = `${PHOTOS_DIR}${id}.jpg`;
        await FileSystem.copyAsync({ from: input.tempPhotoUri, to: permanentPath });
        const dest = await FileSystem.getInfoAsync(permanentPath);
        if (dest.exists) {
          photoUri = permanentPath;
        } else {
          console.warn('Photo copy reported done but the file is missing:', permanentPath);
        }
      }
    } catch (err) {
      console.warn('Photo persist failed; saving article without photo:', err);
      photoUri = null;
    }
  }

  const saved: Article = {
    id,
    source: 'backend_extraction',
    ingestion_id: input.ingestion_id,
    extraction_run_id: input.extraction_run_id,
    captured_at: input.captured_at,
    photo_uri: photoUri,
    barcode_raw: input.barcode_raw ?? null,
    ingestion_status: input.ingestion_status,
    fields: input.fields,
    saved_at: new Date().toISOString(),
    saved_by: input.saved_by ?? null,
    raw_extraction_run: input.raw_extraction_run ?? null,
  };

  // O(1): writes only this article's keys (raw run kept off the hot path by the adapter).
  await store.put(saved);
  return saved;
}

// ─── Update an existing article (in-place human correction from the detail screen) ──

/**
 * Apply human edits to an already-saved article: replace its fields and RE-RECORD the
 * save (fresh `saved_at`, and `saved_by` = the editor) so the record reflects who last
 * touched it. Same id ⇒ store.put overwrites the existing record in place (O(1)); the
 * authoritative backend override is pushed separately (submitFieldOverrides). Returns the
 * updated article, or null if it no longer exists.
 */
export async function updateBackendArticle(
  id: string,
  patch: { fields: ArticleField[]; saved_by?: string | null },
): Promise<Article | null> {
  const existing = await store.getById(id);
  if (!existing) return null;
  const updated: Article = {
    ...existing,
    fields: patch.fields,
    saved_at: new Date().toISOString(),
    saved_by: patch.saved_by !== undefined ? patch.saved_by : existing.saved_by,
  };
  await store.put(updated);
  return updated;
}

// ─── Delete an article ────────────────────────────────────────────────────────

export async function deleteArticle(id: string): Promise<void> {
  const article = await store.getById(id);

  if (article?.photo_uri) {
    try {
      const fileInfo = await FileSystem.getInfoAsync(article.photo_uri);
      if (fileInfo.exists) {
        await FileSystem.deleteAsync(article.photo_uri, { idempotent: true });
      }
    } catch (err) {
      console.warn('Photo delete failed:', err);
    }
  }

  await store.remove(id);
}
