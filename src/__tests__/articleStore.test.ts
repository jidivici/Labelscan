import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  ARTICLE_KEY_PREFIX,
  ARTICLE_RAW_KEY_PREFIX,
  LEGACY_ARTICLES_KEY,
  STORAGE_V2_FLAG,
  type ArticleStore,
} from '../services/articleStore';
import { AsyncStorageArticleStore } from '../services/articleStoreAsyncStorage';
import { InMemoryArticleStore } from '../services/articleStoreMemory';
import type { Article } from '../types/Article';
import type { ExtractionRunResponse } from '../types/api';

function makeArticle(id: string, savedAt: string, extra: Partial<Article> = {}): Article {
  return {
    id,
    source: 'backend_extraction',
    ingestion_id: `ing-${id}`,
    extraction_run_id: `run-${id}`,
    captured_at: '2026-06-21T10:00:00.000Z',
    photo_uri: null,
    barcode_raw: null,
    ingestion_status: 'extracted',
    fields: [
      {
        field_name: 'scientific_name',
        value: 'Gadus morhua',
        combined_confidence: 0.96,
        confidence_band: 'high',
        validation_status: 'present',
      },
    ],
    saved_at: savedAt,
    saved_by: 'op-1',
    raw_extraction_run: null,
    ...extra,
  };
}

const heavyRun = (runId: string) =>
  ({ run_id: runId, ingestion_id: 'i', fields: [] } as unknown as ExtractionRunResponse);

// ── Shared contract: every adapter must satisfy these, identically. ──────────────
function contractSuite(name: string, makeStore: () => ArticleStore) {
  describe(`ArticleStore contract — ${name}`, () => {
    let store: ArticleStore;

    beforeEach(async () => {
      await AsyncStorage.clear();
      store = makeStore();
    });

    it('put then getById round-trips the record', async () => {
      await store.put(makeArticle('a1', '2026-06-21T10:00:00.000Z'));
      const got = await store.getById('a1');
      expect(got?.id).toBe('a1');
      expect(got?.fields[0].value).toBe('Gadus morhua');
    });

    it('getById returns null for a missing id', async () => {
      expect(await store.getById('nope')).toBeNull();
    });

    it('getAll returns newest-first', async () => {
      await store.put(makeArticle('old', '2026-06-20T08:00:00.000Z'));
      await store.put(makeArticle('new', '2026-06-21T08:00:00.000Z'));
      const all = await store.getAll();
      expect(all.map((a) => a.id)).toEqual(['new', 'old']);
    });

    it('put replaces an existing record (upsert, no duplicate)', async () => {
      await store.put(makeArticle('a1', '2026-06-21T10:00:00.000Z', { ingestion_status: 'needs_review' }));
      await store.put(makeArticle('a1', '2026-06-21T11:00:00.000Z', { ingestion_status: 'extracted' }));
      const all = await store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].ingestion_status).toBe('extracted');
    });

    it('remove deletes the record', async () => {
      await store.put(makeArticle('a1', '2026-06-21T10:00:00.000Z'));
      await store.remove('a1');
      expect(await store.getById('a1')).toBeNull();
      expect(await store.getAll()).toHaveLength(0);
    });

    it('keeps raw_extraction_run OUT of the hot path (null on getById/getAll)', async () => {
      await store.put(makeArticle('a1', '2026-06-21T10:00:00.000Z', { raw_extraction_run: heavyRun('r1') }));
      expect((await store.getById('a1'))?.raw_extraction_run).toBeNull();
      expect((await store.getAll())[0].raw_extraction_run).toBeNull();
    });
  });
}

contractSuite('InMemoryArticleStore', () => new InMemoryArticleStore());
contractSuite('AsyncStorageArticleStore', () => new AsyncStorageArticleStore());

// ── AsyncStorage adapter specifics: per-key layout + legacy-blob migration. ──────
describe('AsyncStorageArticleStore — per-key layout & migration (§7.2)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('writes one LIGHT key per article + a separate raw key, never a global blob', async () => {
    const store = new AsyncStorageArticleStore();
    await store.put(makeArticle('a1', '2026-06-21T10:00:00.000Z', { raw_extraction_run: heavyRun('r1') }));

    const keys = await AsyncStorage.getAllKeys();
    expect(keys).toContain(`${ARTICLE_KEY_PREFIX}a1`);
    expect(keys).toContain(`${ARTICLE_RAW_KEY_PREFIX}a1`);

    // the hot-path record does NOT carry the heavy run...
    const light = JSON.parse((await AsyncStorage.getItem(`${ARTICLE_KEY_PREFIX}a1`)) as string);
    expect(light.raw_extraction_run).toBeNull();
    // ...but it is recoverable lazily from its own key
    expect(await store.getRawRun('a1')).toEqual(heavyRun('r1'));
    // and the legacy single blob is never written
    expect(await AsyncStorage.getItem(LEGACY_ARTICLES_KEY)).toBeNull();
  });

  it('migrates the legacy single blob into per-article keys, once, without data loss', async () => {
    const legacy = [
      makeArticle('m1', '2026-06-20T10:00:00.000Z', { raw_extraction_run: heavyRun('rr') }),
      makeArticle('m2', '2026-06-21T10:00:00.000Z'),
      { source: 'legacy_ocr', id: 'skip' }, // a non-backend record must be ignored
    ];
    await AsyncStorage.setItem(LEGACY_ARTICLES_KEY, JSON.stringify(legacy));

    const store = new AsyncStorageArticleStore();
    const all = await store.getAll();
    expect(all.map((a) => a.id)).toEqual(['m2', 'm1']); // newest-first, junk skipped
    expect(await store.getRawRun('m1')).toEqual(heavyRun('rr')); // raw moved to its own key
    // legacy blob kept as a backup; one-shot flag set
    expect(await AsyncStorage.getItem(LEGACY_ARTICLES_KEY)).not.toBeNull();
    expect(await AsyncStorage.getItem(STORAGE_V2_FLAG)).not.toBeNull();
  });

  it('does not re-import the legacy blob once the migration flag is set', async () => {
    await AsyncStorage.setItem(STORAGE_V2_FLAG, '2026-06-21T00:00:00.000Z');
    await AsyncStorage.setItem(
      LEGACY_ARTICLES_KEY,
      JSON.stringify([makeArticle('old', '2026-06-20T10:00:00.000Z')]),
    );
    const store = new AsyncStorageArticleStore();
    expect(await store.getAll()).toHaveLength(0); // flag set → legacy NOT imported
  });
});
