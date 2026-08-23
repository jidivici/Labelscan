/**
 * Storage Service — backend-extraction articles (facade).
 *
 * Record persistence is delegated to an
 * ArticleStore PORT (audit §7.2): the default is the per-key AsyncStorage adapter — no
 * 6 MB blob ceiling, O(1) writes. To run on expo-sqlite in production, implement the port
 * and call setArticleStore(new SqliteArticleStore()) at app init; nothing here changes.
 *
 * The server is the source of truth for confirmed arrivals. This store is retained only
 * for pending scans and as a read-only offline fallback for legacy local records; confirmed
 * arrivals are always requested from the catalogue API first.
 */

import * as FileSystem from 'expo-file-system/legacy';

import { Article } from '../types/Article';
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
  // An optimistic arrival has no server batch id yet; its locally assembled record
  // already contains the complete reviewed field set and is the only available detail.
  if (cached?.id.startsWith('pending-')) return cached;

  // Catalogue rows are deliberately lightweight summaries. Never use one as a product
  // detail merely because it is cached: it only carries a subset of the recovered
  // fields and would make the fiche disagree with the completed review. Fetch the
  // authoritative full record first, keeping the summary solely as an offline fallback.
  const { getCatalogArticle } = await import('./catalogApi');
  const serverArticle = await getCatalogArticle(id);
  return serverArticle ?? cached ?? store.getById(id);
}
