import { API_BASE_URL } from '../config';
import { apiBinaryRequest } from './api';
import { captureActiveSession, isSessionFenceCurrent } from './authStorage';
import { cacheRemoteArticlePhoto, deleteCachedRemoteArticlePhoto, getCachedRemoteArticlePhoto } from './storage';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CONCURRENT_DOWNLOADS = 2;
const pending = new Map<string, Promise<string>>();
let activeDownloads = 0;
const waiting: Array<() => void> = [];

async function withDownloadSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    activeDownloads += 1;
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else activeDownloads -= 1;
  }
}

/** Only generated catalogue paths can initiate a credentialed image download. */
export function remoteArticlePhotoId(uri: string): string | null {
  if (!API_BASE_URL) return null;
  const prefix = `${API_BASE_URL}/v1/arrivals/`;
  if (!uri.startsWith(prefix)) return null;
  return /^([A-Za-z0-9][A-Za-z0-9_-]{0,120})\/image$/.exec(uri.slice(prefix.length))?.[1] ?? null;
}

export async function invalidateRemoteArticlePhoto(uri: string): Promise<void> {
  const batchId = remoteArticlePhotoId(uri);
  if (!batchId) return;
  const fence = await captureActiveSession();
  if (fence && isSessionFenceCurrent(fence)) await deleteCachedRemoteArticlePhoto(batchId, fence);
}

/**
 * Android's native Image network stack does not use our API transport or refresh
 * handling. Download with the same client as the catalogue, then let Image decode
 * a local file. Keep at most two response buffers alive on lower-memory phones.
 */
export async function loadRemoteArticlePhoto(uri: string): Promise<string> {
  const batchId = remoteArticlePhotoId(uri);
  if (!batchId) throw new Error('UNTRUSTED_PHOTO_URL');
  const fence = await captureActiveSession();
  if (!fence || !isSessionFenceCurrent(fence)) throw new Error('MOBILE_SESSION_CHANGED');
  const key = `${fence.generation}:${fence.scopeKey}:${uri}`;
  const existing = pending.get(key);
  if (existing) return existing;

  const download = withDownloadSlot(async () => {
    if (!isSessionFenceCurrent(fence)) throw new Error('MOBILE_SESSION_CHANGED');
    const cached = await getCachedRemoteArticlePhoto(batchId, fence);
    if (!isSessionFenceCurrent(fence)) throw new Error('MOBILE_SESSION_CHANGED');
    if (cached) return cached;
    const bytes = await apiBinaryRequest(`/v1/arrivals/${batchId}/image`, { signal: fence.signal });
    if (!isSessionFenceCurrent(fence)) throw new Error('MOBILE_SESSION_CHANGED');
    if (!bytes?.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('INVALID_PHOTO_RESPONSE');
    }
    return cacheRemoteArticlePhoto(batchId, bytes, fence);
  });
  pending.set(key, download);
  try {
    return await download;
  } finally {
    if (pending.get(key) === download) pending.delete(key);
  }
}
