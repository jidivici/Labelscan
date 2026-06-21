/**
 * Storage Service — backend-extraction articles.
 *  - Article records → AsyncStorage (JSON array)
 *  - Photos → expo-file-system (permanent documents directory)
 *
 * Backend-only: getAllArticles ignores any legacy-shaped records (there is no
 * on-device-OCR data to preserve), and the next save overwrites them out.
 */

import 'react-native-get-random-values'; // crypto polyfill for uuid (also imported in App.tsx)
import { v4 as uuidv4 } from 'uuid';

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { Article, ArticleField } from '../types/Article';
import type { ExtractionRunResponse } from '../types/api';

const ARTICLES_KEY = '@labelscan:articles';
const PHOTOS_DIR = `${FileSystem.documentDirectory}photos/`;

// ─── Ensure photos dir exists ────────────────────────────────────────────────

async function ensurePhotosDirExists(): Promise<void> {
  const dirInfo = await FileSystem.getInfoAsync(PHOTOS_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(PHOTOS_DIR, { intermediates: true });
  }
}

// ─── Read all articles (backend records only) ──────────────────────────────────

export async function getAllArticles(): Promise<Article[]> {
  const raw = await AsyncStorage.getItem(ARTICLES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Ignore any legacy-shaped records — no on-device-OCR data to preserve.
    return parsed.filter((a): a is Article => a?.source === 'backend_extraction');
  } catch {
    return [];
  }
}

// ─── Read one article by id ─────────────────────────────────────────────────────

export async function getArticleById(id: string): Promise<Article | null> {
  const all = await getAllArticles();
  return all.find((a) => a.id === id) ?? null;
}

// ─── Serialized writes ────────────────────────────────────────────────────────
// AsyncStorage has no atomic read-modify-write; this queue serializes both save
// and delete so concurrent mutations can't clobber the list (lost update).
let articlesWriteQueue: Promise<unknown> = Promise.resolve();

function enqueueArticlesWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = articlesWriteQueue.then(task, task);
  articlesWriteQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
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

  return enqueueArticlesWrite(async () => {
    const existing = await getAllArticles();
    const updated = [saved, ...existing]; // newest first
    await AsyncStorage.setItem(ARTICLES_KEY, JSON.stringify(updated));
    return saved;
  });
}

// ─── Delete an article ────────────────────────────────────────────────────────

export async function deleteArticle(id: string): Promise<void> {
  return enqueueArticlesWrite(async () => {
    const existing = await getAllArticles();
    const article = existing.find((a) => a.id === id);

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

    const updated = existing.filter((a) => a.id !== id);
    await AsyncStorage.setItem(ARTICLES_KEY, JSON.stringify(updated));
  });
}


