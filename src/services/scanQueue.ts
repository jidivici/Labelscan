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
 *    persisted under ONE AsyncStorage key. Production release still needs an
 *    enforced capacity quota (tracked as OR-19), not just the expected small usage.
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
import {
  clearPendingScanPhotos,
  deletePendingPhoto,
  deletePendingPhotoStrict,
  isCanonicalPendingPhotoUri,
  persistPendingPhoto,
  sweepPendingPhotos,
} from './storage';
import { hasExploitableExtraction } from './extractionUsability';
import type { ExtractionRunResponse, IngestionStatusResponse } from '../types/api';
import type { TradeCode } from './businessProfiles';
import {
  captureActiveSession,
  getOperatorContext,
  isSessionFenceCurrent,
  operatorContextKey,
  type OperatorContext,
  type SessionFence,
} from './authStorage';

export const QUEUE_KEY = '@labelscan:scanQueue:v2';
const LEGACY_QUEUE_KEY = '@labelscan:scanQueue';
const QUEUE_SCHEMA_VERSION = 2 as const;

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
 *  'recapture_required' → terminal image mismatch/empty extraction — never confirmable
 *  'submit_error' / 'extract_error' → error card (Réessayer / Supprimer)
 */
export type PendingScanStatus =
  | 'submitting'
  | 'extracting'
  | 'ready'
  | 'recapture_required'
  | 'submit_error'
  | 'extract_error';

export interface PendingScan {
  schemaVersion: typeof QUEUE_SCHEMA_VERSION;
  id: string; // local uuid — also the pending photo's file name
  createdAt: string; // ISO 8601 — T0 of the photo→ready latency measure
  photoUri: string; // durable pending/<id>.jpg; temporary cache URIs are never queued
  barcodeRaw?: string;
  capturedAt: string; // ISO 8601 (client capture time, sent to the backend)
  /** Local presentation snapshot only; never copied into the ingestion request. */
  tradeCode: TradeCode;
  /** Exact local owner received from auth; never copied into the ingestion request. */
  organizationId: string;
  actorId: string;
  businessPortalId: string;
  submitOpId: string; // outbox create_ingestion op (transport linkage)
  ingestionId: string | null; // null until the submit succeeded
  status: PendingScanStatus;
  ocrDone?: boolean; // Tier 3 wave 2 reached (drives the banner/stepper detail)
  errorCode?: string;
  /**
   * Persisted review draft (workflow v2 — "session"): the operator's per-field edits,
   * keyed by field_name. Saved when leaving the Review screen so a partially-filled
   * arrivage survives navigating away; the scan stays "en cours" until all profile fields
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
  /** By scan id. Present for a completed extraction, including recapture decisions. */
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
let queueGeneration = 0;

// Serializes queue writes (AsyncStorage has no compare-and-set) — outbox.ts pattern.
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const run = writeQueue.then(task, task);
  // The next write supplies both fulfilment/rejection handlers, so the chain can
  // recover without an additional promise hop after every persistence mutation.
  writeQueue = run;
  return run;
}

function persist(): void {
  const payload = JSON.stringify(scans);
  const generation = queueGeneration;
  void enqueueWrite(async () => {
    if (generation !== queueGeneration) return;
    await AsyncStorage.setItem(QUEUE_KEY, payload).catch(() => undefined);
  });
}

function workflowIsCurrent(generation: number, fence: SessionFence | null): boolean {
  return generation === queueGeneration && isSessionFenceCurrent(fence);
}

function scanMatchesFence(scan: PendingScan, fence: SessionFence): boolean {
  return operatorContextKey({
    organizationId: scan.organizationId,
    actorId: scan.actorId,
    businessPortalId: scan.businessPortalId,
    tradeCode: scan.tradeCode,
  }) === fence.scopeKey;
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
  const ingestionId = scan?.ingestionId;
  if (!scan || !ingestionId) return;
  const generation = queueGeneration;
  const controller = new AbortController();
  controllers.set(id, controller);
  if (!pollStartedAt.has(id)) pollStartedAt.set(id, Date.now());
  void (async () => {
    let shouldRearm = false;
    try {
      shouldRearm = await runPoll(id, ingestionId, controller, generation);
    } finally {
      // An old continuation must not delete the controller of a same-id scan that
      // belongs to a newer queue generation/session.
      if (generation === queueGeneration && controllers.get(id) === controller) {
        controllers.delete(id);
        // Release the slot before re-arming. Re-arming from inside runPoll used to
        // see its own controller and silently stop polling after the first timeout.
        if (shouldRearm) {
          const fence = await captureActiveSession();
          const current = findScan(id);
          if (
            workflowIsCurrent(generation, fence) &&
            fence &&
            current?.status === 'extracting' &&
            scanMatchesFence(current, fence)
          ) {
            schedulePoll(id);
          }
        }
        startNextWaiting();
      }
    }
  })();
}

async function runPoll(
  id: string,
  ingestionId: string,
  controller: AbortController,
  generation: number,
): Promise<boolean> {
  const fence = await captureActiveSession();
  const scan = findScan(id);
  if (!workflowIsCurrent(generation, fence) || !scan || !fence || !scanMatchesFence(scan, fence)) {
    controller.abort();
    return false;
  }
  const startedAt = pollStartedAt.get(id) ?? Date.now();
  const elapsed = Date.now() - startedAt;
  const remaining = TOTAL_POLL_BUDGET_MS - elapsed;
  if (remaining <= 0) {
    pollStartedAt.delete(id);
    updateScan(id, { status: 'extract_error', errorCode: 'TIMEOUT' });
    return false;
  }
  const degraded = elapsed > FIRST_PASS_MS;
  const abortForSessionChange = () => controller.abort();
  fence.signal.addEventListener('abort', abortForSessionChange, { once: true });
  // Close the check→subscribe window if logout happened between the two lines.
  if (fence.signal.aborted) controller.abort();

  let result: Awaited<ReturnType<typeof waitForIngestionResult>>;
  try {
    result = await waitForIngestionResult(ingestionId, {
      signal: controller.signal,
      maxDurationMs: Math.min(degraded ? DEGRADED_PASS_MS : FIRST_PASS_MS, remaining),
      ...(degraded ? { longPollSeconds: 0, baseDelayMs: DEGRADED_BASE_DELAY_MS } : {}),
      onInterim: (values) => {
        if (!workflowIsCurrent(generation, fence)) return;
        interim[id] = values;
        updateScan(id, { ocrDone: true }); // persists + notifies
      },
    });
  } finally {
    fence.signal.removeEventListener('abort', abortForSessionChange);
  }

  if (!workflowIsCurrent(generation, fence) || !findScan(id)) return false;

  switch (result.kind) {
    case 'ready':
      results[id] = { ingestion: result.ingestion, run: result.run };
      delete interim[id];
      pollStartedAt.delete(id);
      updateScan(id, {
        status:
          result.run == null
            ? 'extract_error'
            : result.ingestion.recapture_required === true
              ? 'recapture_required'
              : result.ingestion.recapture_required === false
                ? 'ready'
                : hasExploitableExtraction(result.run.fields, findScan(id)?.tradeCode)
                  ? 'ready'
                  : 'recapture_required',
        ocrDone: true,
        errorCode: result.run ? undefined : 'FIELDS_UNAVAILABLE',
      });
      return false;
    case 'failed':
      pollStartedAt.delete(id);
      // Only the backend's explicit image-quality verdict asks for a new photo.
      // Provider/system failures remain retryable extraction errors: the mobile must
      // never blame the captured image merely because OCR or the LLM failed.
      updateScan(id, {
        status: result.ingestion.recapture_required ? 'recapture_required' : 'extract_error',
        errorCode: result.status,
      });
      return false;
    case 'error':
      pollStartedAt.delete(id);
      updateScan(id, { status: 'extract_error', errorCode: result.code });
      return false;
    case 'timeout':
      // Budget-bounded re-arm (the anchor persists — runPoll degrades then expires).
      return true;
    case 'aborted':
      // Backgrounded or discarded — resume/reconcile re-arms if still relevant.
      return false;
  }
}

// ── Submit outcome handling ───────────────────────────────────────────────────────

function handleSubmitOutcome(
  id: string,
  outcome: SubmitOutcome,
  generation: number,
  fence: SessionFence,
): void {
  if (!workflowIsCurrent(generation, fence)) return;
  const scan = findScan(id);
  if (!scan || !scanMatchesFence(scan, fence)) return; // discarded/session changed while submitting
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
  // A retryable transport failure stays durable in the outbox, but the UI must not
  // spin forever on "Envoi de la photo". Surface the failure immediately; a manual
  // retry reuses this exact operation/idempotency key, and a foreground drain may
  // still replay it automatically.
  updateScan(id, { status: 'submit_error', errorCode: outcome.code });
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
  photoBaseRotationDegrees?: -90 | 0;
}

function scanMatchesOperatorContext(
  value: unknown,
  context: OperatorContext | null,
): value is PendingScan {
  if (context == null || value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const scan = record as unknown as Partial<PendingScan>;
  const allowedKeys = new Set([
    'schemaVersion', 'id', 'createdAt', 'photoUri', 'barcodeRaw', 'capturedAt',
    'tradeCode', 'organizationId', 'actorId', 'businessPortalId', 'submitOpId',
    'ingestionId', 'status', 'ocrDone', 'errorCode', 'edits', 'photoRotationDegrees',
    'photoBaseRotationDegrees', 'finalizeOpId', 'reviewSyncStatus',
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return false;
  const safeId = (value: unknown, nullable = false): boolean =>
    (nullable && value === null) ||
    (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value));
  const safeDate = (value: unknown): boolean =>
    typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
  const safeOptionalText = (value: unknown, max: number): boolean =>
    value === undefined ||
    (typeof value === 'string' && value.length <= max && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value));
  const validStatuses: readonly PendingScanStatus[] = [
    'submitting', 'extracting', 'ready', 'recapture_required', 'submit_error', 'extract_error',
  ];
  const edits = record.edits;
  const editsAreSafe = edits === undefined || (
    edits != null &&
    typeof edits === 'object' &&
    !Array.isArray(edits) &&
    Object.keys(edits).length <= 64 &&
    Object.entries(edits).every(([key, value]) =>
      /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) &&
      typeof value === 'string' &&
      value.length <= 512 &&
      !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
    )
  );
  return (
    scan.schemaVersion === QUEUE_SCHEMA_VERSION &&
    safeId(scan.id) &&
    safeDate(scan.createdAt) &&
    isCanonicalPendingPhotoUri(scan.photoUri) &&
    safeOptionalText(scan.barcodeRaw, 256) &&
    safeDate(scan.capturedAt) &&
    scan.organizationId === context.organizationId &&
    scan.actorId === context.actorId &&
    scan.businessPortalId === context.businessPortalId &&
    scan.tradeCode === context.tradeCode &&
    safeId(scan.submitOpId) &&
    safeId(scan.ingestionId, true) &&
    typeof scan.status === 'string' &&
    validStatuses.includes(scan.status as PendingScanStatus) &&
    (scan.ocrDone === undefined || typeof scan.ocrDone === 'boolean') &&
    safeOptionalText(scan.errorCode, 128) &&
    editsAreSafe &&
    (scan.photoRotationDegrees === undefined ||
      scan.photoRotationDegrees === 0 || scan.photoRotationDegrees === 180) &&
    (scan.photoBaseRotationDegrees === undefined ||
      scan.photoBaseRotationDegrees === -90 || scan.photoBaseRotationDegrees === 0) &&
    (scan.finalizeOpId === undefined || safeId(scan.finalizeOpId)) &&
    (scan.reviewSyncStatus === undefined ||
      scan.reviewSyncStatus === 'pending' || scan.reviewSyncStatus === 'dead_letter')
  );
}

function untrustedCandidatePhotoUri(value: unknown): string | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const uri = (value as Record<string, unknown>).photoUri;
  return typeof uri === 'string' ? uri : null;
}

/**
 * Add a scan and start its submission in the background. Resolves as soon as the
 * entry exists (the camera must not wait on the network).
 */
export async function enqueueScan(input: EnqueueScanInput): Promise<PendingScan> {
  const generation = queueGeneration;
  const fence = await captureActiveSession();
  const owner = await getOperatorContext();
  if (
    !owner ||
    !fence ||
    !workflowIsCurrent(generation, fence) ||
    operatorContextKey(owner) !== fence.scopeKey
  ) {
    throw new Error('MOBILE_CONTEXT_MISSING');
  }
  const id = input.id ?? uuidv4();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || !Number.isFinite(Date.parse(input.capturedAt))) {
    throw new Error('INVALID_SCAN_INPUT');
  }
  // Durable copy first — the cache URI may be purged before the operator reviews.
  // Fail before creating an outbox operation if persistence fails: replaying a
  // temporary URI after restart would be unsafe and cannot recover the photo.
  const photoUri = await persistPendingPhoto(id, input.tempUri);
  if (!photoUri) throw new Error('DURABLE_PHOTO_PERSIST_FAILED');
  if (!workflowIsCurrent(generation, fence)) {
    await deletePendingPhoto(photoUri);
    throw new Error('MOBILE_SESSION_CHANGED');
  }
  const op = await enqueueCapture({
    fileUri: photoUri,
    barcodeRaw: input.barcodeRaw,
    capturedAt: input.capturedAt,
  });
  if (!workflowIsCurrent(generation, fence)) {
    await deletePendingPhoto(photoUri);
    throw new Error('MOBILE_SESSION_CHANGED');
  }
  const scan: PendingScan = {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    id,
    createdAt: new Date().toISOString(),
    photoUri,
    barcodeRaw: input.barcodeRaw,
    capturedAt: input.capturedAt,
    tradeCode: owner.tradeCode as TradeCode,
    organizationId: owner.organizationId,
    actorId: owner.actorId,
    businessPortalId: owner.businessPortalId,
    photoBaseRotationDegrees: input.photoBaseRotationDegrees ?? 0,
    submitOpId: op.id,
    ingestionId: null,
    status: 'submitting',
  };
  scans = [...scans, scan];
  persist();
  notify();

  void executeCreateIngestionOp(op.id).then(
    (outcome) => handleSubmitOutcome(id, outcome, generation, fence),
    () => undefined, // executeCreateIngestionOp never throws by contract; belt-and-braces
  );
  return scan;
}

/** Retry an errored scan: new submission op (submit_error) or fresh poll budget. */
export async function retryScan(id: string): Promise<void> {
  const generation = queueGeneration;
  const fence = await captureActiveSession();
  const scan = findScan(id);
  if (!scan || !fence || !workflowIsCurrent(generation, fence) || !scanMatchesFence(scan, fence)) {
    return;
  }
  if (scan.status === 'submit_error') {
    // A transient failure leaves the original operation pending. Reuse its exact
    // idempotency key on an explicit retry instead of creating another outbox row.
    const existing = await getOperation(scan.submitOpId);
    if (!workflowIsCurrent(generation, fence)) return;
    if (existing?.status === 'pending') {
      updateScan(id, { status: 'submitting', errorCode: undefined });
      void executeCreateIngestionOp(existing.id).then(
        (outcome) => handleSubmitOutcome(id, outcome, generation, fence),
        () => undefined,
      );
      return;
    }
    // A terminal or missing operation needs a fresh outbox row. Server-side content
    // deduplication still protects against a response lost after successful storage.
    const op = await enqueueCapture({
      fileUri: scan.photoUri,
      barcodeRaw: scan.barcodeRaw,
      capturedAt: scan.capturedAt,
    });
    if (!workflowIsCurrent(generation, fence)) return;
    updateScan(id, { submitOpId: op.id, status: 'submitting', errorCode: undefined });
    void executeCreateIngestionOp(op.id).then(
      (outcome) => handleSubmitOutcome(id, outcome, generation, fence),
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

/**
 * Remove a validated scan.  A caller may keep its pending photo briefly while
 * promoting it to durable storage in the background, so the home card can render
 * it without waiting for a potentially large file copy.
 */
export async function completeScan(id: string, options: { keepPhoto?: boolean } = {}): Promise<void> {
  const removed = removeScan(id);
  if (removed && !options.keepPhoto) await deletePendingPhoto(removed.photoUri);
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
  const generation = queueGeneration;
  const fence = await captureActiveSession();
  if (!fence || !workflowIsCurrent(generation, fence)) return;
  try {
    for (const scan of [...scans]) {
      if (!workflowIsCurrent(generation, fence)) return;
      if (!scanMatchesFence(scan, fence)) continue;
      if (scan.finalizeOpId) {
        const finalize = await getOperation(scan.finalizeOpId);
        if (!workflowIsCurrent(generation, fence)) return;
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
      if (scan.status === 'submitting' || scan.status === 'submit_error') {
        const op = await getOperation(scan.submitOpId);
        if (!workflowIsCurrent(generation, fence)) return;
        if (!op) {
          updateScan(scan.id, { status: 'submit_error', errorCode: 'OP_MISSING' });
        } else if (op.status === 'succeeded' && op.result) {
          handleSubmitOutcome(scan.id, {
            kind: 'succeeded',
            ingestionId: op.result.ingestion_id,
            replayed: op.result.replayed,
          }, generation, fence);
        } else if (op.status === 'dead_letter') {
          updateScan(scan.id, {
            status: 'submit_error',
            errorCode: op.last_error_code ?? 'UNKNOWN',
          });
        }
        // pending / in_flight: the outbox drain owns it — leave step 1 running.
      } else if (
        scan.status === 'extracting' ||
        ((scan.status === 'ready' || scan.status === 'recapture_required') && !results[scan.id])
      ) {
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
  const generation = queueGeneration;
  const fence = await captureActiveSession();
  const context = await getOperatorContext();
  if (!context || !fence || !workflowIsCurrent(generation, fence)) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!workflowIsCurrent(generation, fence)) return;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const candidates = parsed as unknown[];
        const safe = candidates.filter((scan) => scanMatchesOperatorContext(scan, context));
        const removed = candidates.filter((scan) => !scanMatchesOperatorContext(scan, context));
        scans = safe;
        await enqueueWrite(async () => {
          if (!workflowIsCurrent(generation, fence)) return;
          await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(safe));
        });
        if (!workflowIsCurrent(generation, fence)) return;
        await Promise.allSettled(
          removed
            .map(untrustedCandidatePhotoUri)
            .filter((uri): uri is string => uri != null)
            .map((uri) => deletePendingPhoto(uri)),
        );
      }
    }
  } catch {
    scans = [];
  }
  if (!workflowIsCurrent(generation, fence)) return;
  notify();
  // Orphans: a crash between the photo copy and the queue write leaves a file no
  // entry references. Fire-and-forget — never blocks startup.
  void sweepPendingPhotos(scans.map((s) => s.photoUri));
  await reconcileScanQueue();
}

/** Purge ownerless/foreign rows from older builds before authentication can replay them. */
export async function purgeUnsafeScanQueueEntries(): Promise<number> {
  const generation = queueGeneration;
  const fence = await captureActiveSession();
  const context = await getOperatorContext();
  let candidates: unknown[] = [];
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (fence && !workflowIsCurrent(generation, fence)) return 0;
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) candidates = parsed;
  } catch {
    candidates = [];
  }
  const safe = candidates.filter((scan) => scanMatchesOperatorContext(scan, context));
  const removed = candidates.filter((scan) => !scanMatchesOperatorContext(scan, context));
  await AsyncStorage.multiRemove([LEGACY_QUEUE_KEY]);
  await enqueueWrite(async () => {
    if (fence && !workflowIsCurrent(generation, fence)) return;
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(safe));
  });
  await Promise.all(
    removed
      .map(untrustedCandidatePhotoUri)
      .filter((uri): uri is string => uri != null)
      .map((uri) => deletePendingPhotoStrict(uri)),
  );
  return removed.length;
}

/** Remove every queued scan/photo when a session ends or is revoked. */
export async function clearScanQueue(): Promise<void> {
  // Invalidate every async continuation before deleting persistence.
  queueGeneration += 1;
  for (const [id] of controllers) abortPoll(id);
  controllers.clear();
  pollStartedAt.clear();
  waitList.length = 0;
  // A new session must derive its pause state from the actual app lifecycle, never
  // inherit a sticky background flag from the previous identity.
  pollsPaused = AppState.currentState != null && AppState.currentState !== 'active';
  scans = [];
  results = {};
  interim = {};
  hydrated = false;
  notify();
  await enqueueWrite(() => AsyncStorage.multiRemove([QUEUE_KEY, LEGACY_QUEUE_KEY]));
  // The directory purge is queued behind capture copies already in flight. A failure
  // propagates to the auth transition, which remains signed out (fail closed).
  await clearPendingScanPhotos();
}

/**
 * Pause polls in background (a 25 s hold in a backgrounded app is wasted work) and
 * resume + reconcile on foreground. Returns an unsubscribe. Call once at app root
 * (same pattern as registerOutboxDrainOnForeground).
 */
export function registerScanQueueLifecycle(): () => void {
  pollsPaused = AppState.currentState != null && AppState.currentState !== 'active';
  const onChange = (state: AppStateStatus) => {
    if (state === 'active') {
      pollsPaused = false;
      void reconcileScanQueue();
    } else if (state === 'background' || state === 'inactive') {
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
  queueGeneration += 1;
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
