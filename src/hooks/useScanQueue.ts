/**
 * React bindings for the scan queue (workflow v1). The queue is a module singleton
 * (src/services/scanQueue.ts) — these hooks are thin useSyncExternalStore adapters;
 * they own NO lifecycle (polls run whether or not any screen is mounted).
 */

import { useSyncExternalStore } from 'react';

import {
  getSnapshot,
  subscribe,
  type PendingScan,
  type ScanQueueSnapshot,
  type ScanResult,
} from '../services/scanQueue';

export function useScanQueue(): ScanQueueSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export interface ScanView {
  scan: PendingScan | null; // null => removed (validated elsewhere / discarded)
  result: ScanResult | null; // present once status is 'ready'
  interimValues: Record<string, string>; // Tier 3 wave-2 preview (while extracting)
}

const NO_INTERIM: Record<string, string> = {};

/** One scan by id — what the Review screen consumes. */
export function useScan(id: string): ScanView {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return {
    scan: snap.scans.find((s) => s.id === id) ?? null,
    result: snap.results[id] ?? null,
    interimValues: snap.interim[id] ?? NO_INTERIM,
  };
}
