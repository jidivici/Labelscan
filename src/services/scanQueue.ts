/**
 * Scan queue (workflow v1) — the single owner of every in-flight scan's lifecycle.
 *
 * The camera fires-and-forgets: each shutter press enqueues a scan here and the
 * operator keeps shooting. This module then drives submit → poll → ready ACROSS
 * screens (no screen owns a poll anymore), and the home screen renders the queue
 * as the "En cours" section with the 3-step counter.
 *
 * Boundaries (do not blur them):
 *  - the OUTBOX stays the durable transport (retry, backoff, dead_letter, stable
 *    idempotency keys). This queue references its ops by id and never re-implements
 *    their retry policy — its own retries are new ops (retryScan) or poll cycles.
 *  - QUEUE ENTRIES are UI workflow state (which scans, which step, which photo),
 *    persisted under ONE AsyncStorage key (bounded: a few dozen entries at most).
 *  - RESULTS (ingestion + run payloads) live in memory only: after a restart they
 *    are re-fetched in one GET (the server embeds latest_fields — it is the truth).
 *
 * Module singleton + subscribe/getSnapshot, consumed via useSyncExternalStore
 * (src/hooks/useScanQueue.ts) — the same service-module pattern as outbox.ts.
 */

import 'react-native-get-random-values'; // crypto polyfill for uuid (also imported in App.tsx)
import { v4 as uuidv4 } from 'uuid';

import { AppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { waitForIngestionResult } from './ingestionResult';
import { enqueueCapture, executeCreateIngestionOp, type SubmitOutcome } from './ingestionSubmit';
import { getOperation } from './outbox';
import { deletePendingPhoto, persistPendingPhoto, sweepPendingPhotos } from './storage';
import type { ExtractionRunResponse, IngestionStatusResponse } from '../types/api';
import type { TradeCode } from './businessProfiles';

const QUEUE_KEY = '@labelscan:scanQueue';

// Cap on simultaneous long-polls (each holds a server connection ~25 s). Scans beyond
// the cap wait in FIFO — with Tier 4 discovery at ~0 ms and extractions at ~10-20 s,
// the line moves fast; N slow parallel cadences would be harder on the server pool.
const MAX_CONCURRENT_POLLS = 3;
// First poll pass rides the long-poll; past it we degrade to a slow classic cadence
// until the total budget runs out (the server keeps extracting regardless).
const FIRST_PASS_MS = 45_000;
const DEGRADED_PASS_MS = 60_000;
const DEGRADED_BASE_DELAY_MS = 5_000;
const TOTAL_POLL_BUDGET_MS = 5 * 60_000;

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Workflow status ↔ the home-screen 3-step counter:
 *  'submitting'   → step 1 (Photo envoyée) running
 *  'extracting'   → step 2 (Extraction) running
 *  'ready'        → step 3 (À valider) — the card opens the Review screen
 *  'submit_error' / 'extract_error' → error card (Réessayer / Supprimer)
 */
export type PendingScanStatus =
  | 'submitting'
  | 'extracting'
  | 'ready'
  | 'submit_error'
  | 'extract_error';

export interface PendingScan {
  id: string; // local uuid — also the pending photo's file name
  createdAt: string; // ISO 8601 — T0 of the photo→ready latency measure
  photoUri: string; // durable pending/<id>.jpg (original cache uri if the copy failed)
  barcodeRaw?: string;
  capturedAt: string; // ISO 8601 (client capture time, sent to the backend)
  /** Local presentation snapshot only; never copied into the ingestion request. */
  tradeCode?: TradeCode;
  /** Local queue owner received from auth; never copied into the ingestion request. */
  businessPortalId?: string;
  submitOpId: string; // outbox create_ingestion op (transport linkage)
  ingestionId: string | null; // null until the submit succeeded
  status: PendingScanStatus;
  ocrDone?: boolean; // Tier 3 wave 2 reached (drives the banner/stepper detail)
  errorCode?: string;
  /**
   * Persisted review draft (workflow v2 — "session"): the operator's per-field edits,
   * keyed by field_name. Saved when leaving the Review screen so a partially-filled
   * arrivage survives navigating away; the scan stays "en cours" until all 17 fields
   * are filled and it is validated (then completeScan drops it). Undefined = untouched.
   */
  edits?: Record<string, string>;
  /** Operator-approved half-turn applied to catalogue displays after review. */
  photoRotationDegrees?: 0 | 180;
  /** Historical raw photos need -90° on display; new crops are already upright. */
  photoBaseRotationDegrees?: -90 | 0;
  /** Durable atomic review operation; the scan stays visible until it succeeds. */
  finalizeOpId?: string;
  reviewSyncStatus?: 'pending' | 'dead_letter';
}

/** Review-ready payload for one scan (in-memory only — the server is the truth). */
export interface ScanResult {
  ingestion: IngestionStatusResponse;
  run: ExtractionRunResponse | null;
}

export interface ScanQueueSnapshot {
  scans: readonly PendingScan[];
  /** By scan id. Present only for status 'ready' (and cleared on complete/discard). */
  results: Readonly<Record<string, ScanResult>>;
  /** Tier 3 wave-2 preview values by scan id, while status is 'extracting'. */
  interim: Readonly<Record<string, Record<string, string>>>;
}

// ── State (module singleton) ─────────────────────────────────────────────────────

let scans: PendingScan[] = [];
let results: Record<string, ScanResult> = {};
let interim: Record<string, Record<string, string>> = {};
let snapshot: ScanQueueSnapshot = { scans: [], results: {}, interim: {} };
const listeners = new Set<() => void>();
let hydrated = false;

// Poll machinery — one AbortController per scan; FIFO wait list beyond the cap.
const controllers = new Map<string, AbortController>();
const pollStartedAt = new Map<string, number>(); // per-scan total-budget anchor
const waitList: string[] = [];
let pollsPaused = false; // true while the app is backgrounded

// Serializes queue writes (AsyncStorage has no compare-and-set) — outbox.ts pattern.
let writeQueue: Promise<unknown> = Promise.resolve();

function persist(): void {
  const payload = JSON.stringify(scans);
  writeQueue = writeQueue.then(
    () => AsyncStorage.setItem(QUEUE_KEY, payload).catch(() => undefined),
    () => undefined,
  );
}

function notify(): void {
  snapshot = { scans: [...scans], results: { ...results }, interim: { ...interim } };
  for (const cb of listeners) cb();
}

function findScan(id: string): PendingScan | undefined {
  return scans.find((s) => s.id === id);
}

function updateScan(id: string, patch: Partial<PendingScan>): PendingScan | null {
  let updated: PendingScan | null = null;
  scans = scans.map((s) => {
    if (s.id !== id) return s;
    updated = { ...s, ...patch };
    return updated;
  });
  if (updated) {
    persist();
    notify();
  }
  return updated;
}

function removeScan(id: string): PendingScan | null {
  const scan = findScan(id) ?? null;
  if (!scan) return null;
  abortPoll(id);
  pollStartedAt.delete(id);
  delete results[id];
  delete interim[id];
  scans = scans.filter((s) => s.id !== id);
  persist();
  notify();
  return scan;
}

// ── Public store surface (useSyncExternalStore contract) ─────────────────────────

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSnapshot(): ScanQueueSnapshot {
  return snapshot;
}

// ── Poll scheduler ────────────────────────────────────────────────────────────────

function abortPoll(id: string): void {
  controllers.get(id)?.abort();
  const waiting = waitList.indexOf(id);
  if (waiting >= 0) waitList.splice(waiting, 1);
}

function schedulePoll(id: string): void {
  if (pollsPaused) return; // foreground resume re-arms every 'extracting' scan
  if (controllers.has(id) || waitList.includes(id)) return;
  if (controllers.size >= MAX_CONCURRENT_POLLS) {
    waitList.push(id);
    return;
  }
  startPoll(id);
}

function startNextWaiting(): void {
  if (pollsPaused) return;
  while (waitList.length > 0 && controllers.size < MAX_CONCURRENT_POLLS) {
    const next = waitList.shift();
    if (next && findScan(next)) startPoll(next);
  }
}

function startPoll(id: string): void {
  const scan = findScan(id);
  if (!scan?.ingestionId) return;
  const controller = new AbortController();
  controllers.set(id, controller);
  if (!pollStartedAt.has(id)) pollStartedAt.set(id, Date.now());
  void runPoll(id, scan.ingestionId, controller).finally(() => {
    controllers.delete(id);
    startNextWaiting();
  });
}

async function runPoll(id: string, ingestionId: string, controller: AbortController): Promise<void> {
  const startedAt = pollStartedAt.get(id) ?? Date.now();
  const elapsed = Date.now() - startedAt;
  const remaining = TOTAL_POLL_BUDGET_MS - elapsed;
  if (remaining <= 0) {
    pollStartedAt.delete(id);
    updateScan(id, { status: 'extract_error', errorCode: 'TIMEOUT' });
    return;
  }
  const degraded = elapsed > FIRST_PASS_MS;

  const result = await waitForIngestionResult(ingestionId, {
    signal: controller.signal,
    maxDurationMs: Math.min(degraded ? DEGRADED_PASS_MS : FIRST_PASS_MS, remaining),
    ...(degraded ? { longPollSeconds: 0, baseDelayMs: DEGRADED_BASE_DELAY_MS } : {}),
    onInterim: (values) => {
      interim[id] = values;
      updateScan(id, { ocrDone: true }); // persists + notifies
    },
  });

  if (!findScan(id)) return; // discarded/completed while polling

  switch (result.kind) {
    case 'ready':
      results[id] = { ingestion: result.ingestion, run: result.run };
      delete interim[id];
      pollStartedAt.delete(id);
      updateScan(id, { status: 'ready', ocrDone: true, errorCode: undefined });
      break;
    case 'failed':
      pollStartedAt.delete(id);
      updateScan(id, { status: 'extract_error', errorCode: result.status });
      break;
    case 'error':
      pollStartedAt.delete(id);
      updateScan(id, { status: 'extract_error', errorCode: result.code });
      break;
    case 'timeout':
      // Budget-bounded re-arm (the anchor persists — runPoll degrades then expires).
      schedulePollAfterCurrent(id);
      break;
    case 'aborted':
      // Backgrounded or discarded — resume/reconcile re-arms if still relevant.
      break;
  }
}

// A timeout re-arm must not re-enter startPoll while runPoll's finally has not yet
// released the controller slot — defer one microtask so the slot count is accurate.
function schedulePollAfterCurrent(id: string): void {
  void Promise.resolve().then(() => {
    if (findScan(id)?.status === 'extracting') schedulePoll(id);
  });
}

// ── Submit outcome handling ───────────────────────────────────────────────────────

function handleSubmitOutcome(id: string, outcome: SubmitOutcome): void {
  const scan = findScan(id);
  if (!scan) return; // discarded while submitting
  if (outcome.kind === 'succeeded') {
    // Replay dedup: two identical photos (server dedups on the content hash) yield the
    // SAME ingestion — a second queue entry would double-poll and double-review it.
    const duplicate = outcome.replayed
      ? scans.find((s) => s.id !== id && s.ingestionId === outcome.ingestionId)
      : undefined;
    if (duplicate) {
      const removed = removeScan(id);
      if (removed) void deletePendingPhoto(removed.photoUri);
      return;
    }
    updateScan(id, { ingestionId: outcome.ingestionId, status: 'extracting', errorCode: undefined });
    schedulePoll(id);
    return;
  }
  if (outcome.kind === 'dead_letter') {
    updateScan(id, { status: 'submit_error', errorCode: outcome.code });
    return;
  }
  // 'pending': the op stays on the outbox with its backoff; the drain replays it and
  // reconcileScanQueue() (drain hook / foreground) advances this scan when it lands.
}

// ── Public API ────────────────────────────────────────────────────────────────────

export interface EnqueueScanInput {
  /**
   * Pre-generated id (the caller already used it to persist a durable copy of the
   * raw capture before cropping — see CameraScreen). Falls back to a fresh uuid.
   */
  id?: string;
  tempUri: string; // cropped capture (ImageManipulator cache uri), or an already-durable uri
  barcodeRaw?: string;
  capturedAt: string; // ISO 8601
  /** Received from authenticated server context; retained locally for review UX only. */
  tradeCode?: TradeCode;
  /** Received from authenticated server context; retained locally for isolation only. */
  businessPortalId?: string;
  photoBaseRotationDegrees?: -90 | 0;
}

/**
 * Add a scan and start its submission in the background. Resolves as soon as the
 * entry exists (the camera must not wait on the network).
 */
export async function enqueueScan(input: EnqueueScanInput): Promise<PendingScan> {
  const id = input.id ?? uuidv4();
  // Durable copy first — the cache uri may be purged before the operator reviews.
  // On copy failure, degrade to the input uri (scan proceeds; photo may not survive
  // a restart, which the review screen already tolerates).
  const photoUri = (await persistPendingPhoto(id, input.tempUri)) ?? input.tempUri;
  const op = await enqueueCapture({
    fileUri: photoUri,
    barcodeRaw: input.barcodeRaw,
    capturedAt: input.capturedAt,
  });
  const scan: PendingScan = {
    id,
    createdAt: new Date().toISOString(),
    photoUri,
    barcodeRaw: input.barcodeRaw,
    capturedAt: input.capturedAt,
    tradeCode: input.tradeCode,
    businessPortalId: input.businessPortalId,
    photoBaseRotationDegrees: input.photoBaseRotationDegrees ?? 0,
    submitOpId: op.id,
    ingestionId: null,
    status: 'submitting',
  };
  scans = [...scans, scan];
  persist();
  notify();

  void executeCreateIngestionOp(op.id).then(
    (outcome) => handleSubmitOutcome(id, outcome),
    () => undefined, // executeCreateIngestionOp never throws by contract; belt-and-braces
  );
  return scan;
}

/** Retry an errored scan: new submission op (submit_error) or fresh poll budget. */
export async function retryScan(id: string): Promise<void> {
  const scan = findScan(id);
  if (!scan) return;
  if (scan.status === 'submit_error') {
    // New op, new stable keys — the server dedups identical content by hash, so a
    // retry can never create a duplicate ingestion.
    const op = await enqueueCapture({
      fileUri: scan.photoUri,
      barcodeRaw: scan.barcodeRaw,
      capturedAt: scan.capturedAt,
    });
    updateScan(id, { submitOpId: op.id, status: 'submitting', errorCode: undefined });
    void executeCreateIngestionOp(op.id).then(
      (outcome) => handleSubmitOutcome(id, outcome),
      () => undefined,
    );
    return;
  }
  if (scan.status === 'extract_error') {
    pollStartedAt.delete(id); // fresh budget
    updateScan(id, { status: 'extracting', errorCode: undefined });
    schedulePoll(id);
  }
}

/** Remove a scan the operator gave up on (confirm handled by the caller's UI). */
export async function discardScan(id: string): Promise<void> {
  // If its create op is still pending on the outbox, a later drain may still create
  // the server ingestion (append-only, harmless) or dead-letter on the missing file.
  const removed = removeScan(id);
  if (removed) await deletePendingPhoto(removed.photoUri);
}

/**
 * Persist the operator's in-progress review edits for a scan (workflow v2 "session").
 * Called when leaving the Review screen so a partially-filled arrivage is restored on
 * re-open. No-op if the scan is gone (validated/discarded meanwhile).
 */
export function saveScanEdits(id: string, edits: Record<string, string>): void {
  if (!findScan(id)) return;
  updateScan(id, { edits });
}

export function saveScanPhotoRotation(id: string, photoRotationDegrees: 0 | 180): void {
  if (!findScan(id)) return;
  updateScan(id, { photoRotationDegrees });
}

/** Link the scan to its already-persisted finalization operation. */
export function attachFinalizeOperation(id: string, operationId: string): void {
  updateScan(id, {
    finalizeOpId: operationId,
    reviewSyncStatus: 'pending',
  });
}

/** Remove a validated scan (the article save already copied the photo out). */
export async function completeScan(id: string): Promise<void> {
  const removed = removeScan(id);
  if (removed) await deletePendingPhoto(removed.photoUri);
}

/**
 * Reconcile workflow state with the transport (outbox) and re-arm polls:
 *  - 'submitting' scans read their op: succeeded → extracting (+poll),
 *    dead_letter → submit_error, missing → submit_error (op purged/lost);
 *  - 'extracting' scans (and 'ready' ones whose in-memory result is gone —
 *    restart) get a poll cycle.
 * Called at startup, on foreground, and after each outbox drain. Never throws.
 */
export async function reconcileScanQueue(): Promise<void> {
  try {
    for (const scan of [...scans]) {
      if (scan.finalizeOpId) {
        const finalize = await getOperation(scan.finalizeOpId);
        if (finalize?.status === 'succeeded') {
          await completeScan(scan.id);
          continue;
        }
        if (finalize?.status === 'dead_letter') {
          updateScan(scan.id, { reviewSyncStatus: 'dead_letter' });
          continue;
        }
        updateScan(scan.id, { reviewSyncStatus: 'pending' });
      }
      if (scan.status === 'submitting') {
        const op = await getOperation(scan.submitOpId);
        if (!op) {
          updateScan(scan.id, { status: 'submit_error', errorCode: 'OP_MISSING' });
        } else if (op.status === 'succeeded' && op.result) {
          handleSubmitOutcome(scan.id, {
            kind: 'succeeded',
            ingestionId: op.result.ingestion_id,
            replayed: op.result.replayed,
          });
        } else if (op.status === 'dead_letter') {
          updateScan(scan.id, {
            status: 'submit_error',
            errorCode: op.last_error_code ?? 'UNKNOWN',
          });
        }
        // pending / in_flight: the outbox drain owns it — leave step 1 running.
      } else if (scan.status === 'extracting' || (scan.status === 'ready' && !results[scan.id])) {
        schedulePoll(scan.id);
      }
    }
  } catch {
    // Storage hiccup — the next trigger (foreground/drain) retries.
  }
}

/** Load the persisted queue, sweep orphan photos, reconcile. Call once at app root. */
export async function initScanQueue(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) scans = parsed as PendingScan[];
    }
  } catch {
    scans = [];
  }
  notify();
  // Orphans: a crash between the photo copy and the queue write leaves a file no
  // entry references. Fire-and-forget — never blocks startup.
  void sweepPendingPhotos(scans.map((s) => s.photoUri));
  await reconcileScanQueue();
}

/**
 * Pause polls in background (a 25 s hold in a backgrounded app is wasted work) and
 * resume + reconcile on foreground. Returns an unsubscribe. Call once at app root
 * (same pattern as registerOutboxDrainOnForeground).
 */
export function registerScanQueueLifecycle(): () => void {
  const onChange = (state: AppStateStatus) => {
    if (state === 'active') {
      pollsPaused = false;
      void reconcileScanQueue();
    } else if (state === 'background') {
      pollsPaused = true;
      for (const [id] of controllers) abortPoll(id);
      waitList.length = 0;
    }
  };
  const sub = AppState.addEventListener('change', onChange);
  return () => sub.remove();
}

// ── Test support ──────────────────────────────────────────────────────────────────

/** Reset ALL module state (jest only — the queue is a process-lifetime singleton). */
export function _resetScanQueueForTests(): void {
  for (const [id] of controllers) controllers.get(id)?.abort();
  controllers.clear();
  pollStartedAt.clear();
  waitList.length = 0;
  pollsPaused = false;
  scans = [];
  results = {};
  interim = {};
  hydrated = false;
  listeners.clear();
  snapshot = { scans: [], results: {}, interim: {} };
  writeQueue = Promise.resolve();
}
