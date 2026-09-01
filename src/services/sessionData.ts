import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  ARTICLE_KEY_PREFIX,
  ARTICLE_RAW_KEY_PREFIX,
  LEGACY_ARTICLES_KEY,
  STORAGE_V2_FLAG,
} from './articleStore';
import { clearOutbox, purgeUnsafeOutboxOperations } from './outbox';
import { clearScanQueue, purgeUnsafeScanQueueEntries } from './scanQueue';
import { queryClient } from './queryClient';
import { clearLocalArticlePhotos, retainLocalArticlePhotosForScope } from './storage';

const LEGACY_QUERY_CACHE_KEY = '@labelscan:query-cache';
const LOCAL_DATA_MIGRATION_KEY = '@labelscan:local-data-migration';
const LOCAL_DATA_MIGRATION_VERSION = '3';
let sessionDataQueue: Promise<unknown> = Promise.resolve();

function serializeSessionDataMutation(task: () => Promise<void>): Promise<void> {
  const run = sessionDataQueue.then(task, task);
  sessionDataQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function attemptPurge(
  task: () => Promise<unknown>,
  failures: unknown[],
): Promise<void> {
  try {
    await task();
  } catch (error) {
    // Continue purging every store, then fail closed so auth cannot become active.
    failures.push(error);
  }
}

function assertPurgeSucceeded(failures: unknown[]): void {
  if (failures.length > 0) throw new Error('LOCAL_SESSION_PURGE_FAILED');
}

async function removeLegacyArticleRows(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const sensitive = keys.filter(
    (key) =>
      key === LEGACY_ARTICLES_KEY ||
      key === STORAGE_V2_FLAG ||
      key.startsWith(ARTICLE_KEY_PREFIX) ||
      key.startsWith(ARTICLE_RAW_KEY_PREFIX),
  );
  if (sensitive.length > 0) await AsyncStorage.multiRemove(sensitive);
}

/** One-time upgrade cleanup: old caches/articles were not tenant scoped. */
export async function purgeLegacyLocalData(
  options: { failClosed?: boolean; ownerScopeKey?: string } = {},
): Promise<void> {
  return serializeSessionDataMutation(async () => {
    queryClient.clear();
    const failures: unknown[] = [];
    let migratedVersion: string | null = null;
    await attemptPurge(async () => {
      migratedVersion = await AsyncStorage.getItem(LOCAL_DATA_MIGRATION_KEY);
    }, failures);
    await attemptPurge(purgeUnsafeScanQueueEntries, failures);
    await attemptPurge(purgeUnsafeOutboxOperations, failures);
    await attemptPurge(() => AsyncStorage.removeItem(LEGACY_QUERY_CACHE_KEY), failures);
    if (options.ownerScopeKey) {
      await attemptPurge(
        () => retainLocalArticlePhotosForScope(options.ownerScopeKey!),
        failures,
      );
    }

    // The destructive legacy/photo sweep is versioned one-shot. Normal cold starts
    // retain the current operator's confirmed-photo cache.
    if (migratedVersion !== LOCAL_DATA_MIGRATION_VERSION) {
      const migrationFailureCount = failures.length;
      await attemptPurge(removeLegacyArticleRows, failures);
      await attemptPurge(clearLocalArticlePhotos, failures);
      if (failures.length === migrationFailureCount) {
        await attemptPurge(
          () => AsyncStorage.setItem(LOCAL_DATA_MIGRATION_KEY, LOCAL_DATA_MIGRATION_VERSION),
          failures,
        );
      }
    }
    if (options.failClosed) assertPurgeSucceeded(failures);
  });
}

/** Logout/revocation cleanup: no data from the previous identity survives. */
export async function clearLocalSessionData(): Promise<void> {
  return serializeSessionDataMutation(async () => {
    queryClient.clear();
    const failures: unknown[] = [];
    // Each queue purge runs through that queue's own write mutex. Keeping the two
    // purges in this global transition mutex also prevents overlapping logout/scope
    // changes from interleaving their delete and rehydration phases.
    await attemptPurge(clearScanQueue, failures);
    await attemptPurge(clearOutbox, failures);
    await attemptPurge(() => AsyncStorage.removeItem(LEGACY_QUERY_CACHE_KEY), failures);
    await attemptPurge(removeLegacyArticleRows, failures);
    await attemptPurge(clearLocalArticlePhotos, failures);
    assertPurgeSucceeded(failures);
  });
}
