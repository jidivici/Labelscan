/**
 * Storage Service — backend-extraction articles (facade).
 *
 * Public API unchanged (getAllArticles / getArticleById / saveBackendArticle /
 * deleteArticle) so the screens don't move. Record persistence is delegated to an
 * ArticleStore PORT (audit §7.2): the default is the per-key AsyncStorage adapter — no
 * 6 MB blob ceiling, O(1) writes. To run on expo-sqlite in production, implement the port
 * and call setArticleStore(new SqliteArticleStore()) at app init; nothing here changes.
 *
 * The server is the source of truth for confirmed arrivals. This store is retained only
 * for pending scans and as an offline fallback for legacy local records; confirmed
 * arrivals are always requested from the catalogue API first.
 */

import 'react-native-get-random-values'; // crypto polyfill for uuid (also imported in App.tsx)
import { v4 as uuidv4 } from 'uuid';

import * as FileSystem from 'expo-file-system/legacy';

import { Article, ArticleField } from '../types/Article';
import type { ExtractionRunResponse } from '../types/api';
import type { ArticleStore } from './articleStore';
import { AsyncStorageArticleStore } from './articleStoreAsyncStorage';
import { queryClient } from './queryClient';

const PHOTOS_DIR = `${FileSystem.documentDirectory}photos/`;
// Workflow v1: photos of scans still in the queue (not yet validated). Durable — the
// ImageManipulator cache uri the camera hands over may be purged by the OS before the
// operator reviews the scan. Owned by scanQueue.ts; swept of orphans at startup.
const PENDING_DIR = `${FileSystem.documentDirectory}pending/`;

// The active persistence engine. Default = per-key AsyncStorage (§7.2). SWAP POINT for a
// future SqliteArticleStore (expo-sqlite, indexed + FTS5): inject it once at app init.
let store: ArticleStore = new AsyncStorageArticleStore();

/** Replace the storage engine (e.g. inject SqliteArticleStore in prod, a fake in tests). */
export function setArticleStore(next: ArticleStore): void {
  store = next;
}

// ─── Ensure photos dir exists ────────────────────────────────────────────────

async function ensureDirExists(dir: string): Promise<void> {
  const dirInfo = await FileSystem.getInfoAsync(dir);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

/**
 * Copy a photo into `dir` as `<name>.jpg` and verify the copy landed.
 *  - COPY, not move: the source may still be displayed/uploaded from its original uri.
 *  - Fixed ".jpg": the capture+crop pipeline always emits JPEG; deriving the extension
 *    from an ImageManipulator cache uri is unreliable (silent persistence failure).
 * Returns the destination uri, or null if the source is missing / the copy failed.
 */
async function persistPhotoInto(dir: string, name: string, srcUri: string): Promise<string | null> {
  try {
    await ensureDirExists(dir);
    const src = await FileSystem.getInfoAsync(srcUri);
    if (!src.exists) {
      console.warn('Photo source missing at persist time:', srcUri);
      return null;
    }
    const destPath = `${dir}${name}.jpg`;
    await FileSystem.copyAsync({ from: srcUri, to: destPath });
    const dest = await FileSystem.getInfoAsync(destPath);
    if (!dest.exists) {
      console.warn('Photo copy reported done but the file is missing:', destPath);
      return null;
    }
    return destPath;
  } catch (err) {
    console.warn('Photo persist failed:', err);
    return null;
  }
}

// ─── Pending-scan photos (workflow v1 — owned by scanQueue) ─────────────────────

/** Persist a captured photo durably for a queued scan. Null on failure. */
export function persistPendingPhoto(scanId: string, srcUri: string): Promise<string | null> {
  return persistPhotoInto(PENDING_DIR, scanId, srcUri);
}

/** Keep the reviewed photo available instantly after its pending scan is removed. */
export function persistConfirmedPhoto(ingestionId: string, srcUri: string): Promise<string | null> {
  return persistPhotoInto(PHOTOS_DIR, ingestionId, srcUri);
}

/** Delete a pending photo. Idempotent, never throws. */
export async function deletePendingPhoto(uri: string): Promise<void> {
  // Only ever delete inside the pending dir (a failed persist can leave a scan
  // pointing at its original cache uri — that one is the OS's to purge, not ours).
  if (!uri.startsWith(PENDING_DIR)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (err) {
    console.warn('Pending photo delete failed:', err);
  }
}

/**
 * Startup sweep: delete every file in the pending dir that no queued scan references
 * (crash between the photo copy and the queue write leaves an orphan). Never throws.
 */
export async function sweepPendingPhotos(referencedUris: readonly string[]): Promise<void> {
  try {
    const dirInfo = await FileSystem.getInfoAsync(PENDING_DIR);
    if (!dirInfo.exists) return;
    const referenced = new Set(referencedUris);
    const names = await FileSystem.readDirectoryAsync(PENDING_DIR);
    for (const name of names) {
      const uri = `${PENDING_DIR}${name}`;
      if (!referenced.has(uri)) {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      }
    }
  } catch (err) {
    console.warn('Pending photo sweep failed:', err);
  }
}

// ─── Confirmed-arrival reads (server first, legacy fallback offline) ─────────────

export async function getAllArticles(): Promise<Article[]> {
  try {
    const { listCatalogArticles } = await import('./catalogApi');
    return await listCatalogArticles();
  } catch {
    // Offline consultation remains possible for records created by older app versions.
    return store.getAll();
  }
}

export async function getArticleById(id: string): Promise<Article | null> {
  const cached = queryClient.getQueryData<Article[]>(['catalog', 'arrivals'])
    ?.find((article) => article.id === id);
  if (cached) return cached;
  const { getCatalogArticle } = await import('./catalogApi');
  const serverArticle = await getCatalogArticle(id);
  return serverArticle ?? store.getById(id);
}

// ─── Legacy local-record helpers ────────────────────────────────────────────────
//
// Kept for one-version migration compatibility. New confirmed arrivals must use the
// finalize-review API and are not written through these functions.

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

  // Persist the captured photo into permanent storage (shared persistPhotoInto —
  // copy + verify; a failure saves the article without photo rather than aborting).
  let photoUri: string | null = null;
  if (input.tempPhotoUri) {
    photoUri = await persistPhotoInto(PHOTOS_DIR, id, input.tempPhotoUri);
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
