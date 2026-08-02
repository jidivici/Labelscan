/**
 * Offline outbox (Batch 5 — PREPARED, not yet wired to the UI or a worker).
 *
 * A persistent queue of pending backend operations, stored in AsyncStorage (the
 * mechanism already used by src/services/storage.ts) under a single JSON-array
 * key. No backend calls happen here; this module only persists operations and
 * their retry metadata so a later batch can drain them.
 *
 * Guarantees:
 *  - stable id / Idempotency-Key / X-Correlation-Id generated ONCE at enqueue and
 *    never regenerated, so retries dedup correctly on the backend.
 *  - read-modify-write is serialized through a module-level mutex, so concurrent
 *    mutations within one JS runtime can't clobber the queue.
 *  - exponential backoff with jitter; obvious client/config errors and exhausted
 *    attempts move to dead_letter rather than retrying forever.
 *
 * No secrets or tokens are stored.
 */

import 'react-native-get-random-values'; // crypto polyfill for uuid (also imported in App.tsx)
import { v4 as uuidv4 } from 'uuid';

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { UploadFilePart } from './api';

const OUTBOX_KEY = '@labelscan:outbox';

export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60 * 1_000; // cap a single backoff at 5 minutes
const JITTER_RATIO = 0.5; // add up to +50% jitter
const MAX_ERROR_MESSAGE_LEN = 1_000;

// ── Types ──────────────────────────────────────────────────────────────────────

export type OutboxStatus = 'pending' | 'in_flight' | 'succeeded' | 'dead_letter';
export type OutboxOperationType =
  | 'create_ingestion'
  | 'poll_ingestion_status'
  | 'override_field'
  | 'confirm_ingestion'
  | 'finalize_review';

/** Payload for POST /v1/ingestions (mirrors the Batch-4 createIngestion args). */
export interface CreateIngestionPayload {
  file: UploadFilePart;
  barcode_raw?: string;
  client_captured_at?: string;
}

/** Payload for GET /v1/ingestions/{id} (optional follow-up operation). */
export interface PollIngestionStatusPayload {
  ingestion_id: string;
}

/** Payload for PATCH /v1/ingestions/{id}/fields/{name} — a human field correction. */
export interface OverrideFieldPayload {
  ingestion_id: string;
  field_name: string;
  value: string | null; // null => the reviewer cleared the field
  note?: string;
  /** Explicit acknowledgement required by the server to override a GS1-owned field. */
  force_gs1?: boolean;
}

/** Payload for POST /v1/ingestions/{id}/confirm — finalize the review (P3). */
export interface ConfirmIngestionPayload {
  ingestion_id: string;
}

/** Complete atomic human review persisted by POST /reviews. */
export interface FinalizeReviewPayload {
  ingestion_id: string;
  fields: Record<string, string | null>;
  note?: string;
}

/** Result recorded on a succeeded create_ingestion op (read by the polling batch). */
export interface OutboxResult {
  ingestion_id: string;
  status: string;
  replayed: boolean;
}

interface OutboxOperationBase {
  id: string; // stable operation id
  idempotencyKey: string; // stable per operation (sent as Idempotency-Key)
  correlationId: string; // stable per operation (sent as X-Correlation-Id)
  status: OutboxStatus;
  attempt_count: number;
  next_attempt_at: string; // ISO 8601; the op is "due" when this <= now
  last_error_code: string | null;
  last_error_message: string | null;
  result: OutboxResult | null; // set on success; carries the ingestion_id for the next batch
  created_at: string;
  updated_at: string;
}

export interface CreateIngestionOperation extends OutboxOperationBase {
  type: 'create_ingestion';
  payload: CreateIngestionPayload;
}

export interface PollIngestionStatusOperation extends OutboxOperationBase {
  type: 'poll_ingestion_status';
  payload: PollIngestionStatusPayload;
}

export interface OverrideFieldOperation extends OutboxOperationBase {
  type: 'override_field';
  payload: OverrideFieldPayload;
}

export interface ConfirmIngestionOperation extends OutboxOperationBase {
  type: 'confirm_ingestion';
  payload: ConfirmIngestionPayload;
}

export interface FinalizeReviewOperation extends OutboxOperationBase {
  type: 'finalize_review';
  payload: FinalizeReviewPayload;
}

export type OutboxOperation =
  | CreateIngestionOperation
  | PollIngestionStatusOperation
  | OverrideFieldOperation
  | ConfirmIngestionOperation
  | FinalizeReviewOperation;

/** Error info supplied to markFailed (e.g. derived from the Batch-4 ApiError). */
export interface OperationError {
  code: string;
  status: number; // 0 for network/timeout/config errors
  message?: string;
  retriable?: boolean; // when known (ApiError.retriable); else inferred from code/status
}

/** Overrides for deterministic tests; production calls omit these. */
export interface EnqueueOptions {
  id?: string;
  idempotencyKey?: string;
  correlationId?: string;
  now?: number; // ms epoch, default Date.now()
}

// ── Pure retry/backoff helpers (exported for testing) ────────────────────────────

/** Backoff for the Nth attempt (attemptCount >= 1): capped exponential + jitter. */
export function backoffDelayMs(
  attemptCount: number,
  baseMs: number = BASE_DELAY_MS,
  maxMs: number = MAX_DELAY_MS,
): number {
  const exponent = Math.max(0, attemptCount - 1);
  const capped = Math.min(baseMs * 2 ** exponent, maxMs);
  const jitter = Math.random() * capped * JITTER_RATIO;
  return Math.min(Math.round(capped + jitter), maxMs);
}

// Client/config errors that retrying cannot fix — fail fast to dead_letter.
const NON_RETRYABLE_CODES = new Set<string>([
  'CONFIG_ERROR',
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',
  'IDEMPOTENCY_KEY_CONFLICT',
  'ALERT_INVALID_TRANSITION',
  'FILE_NOT_FOUND', // the upload file is gone (OS-purged cache / discarded scan) — never comes back
]);

/** Whether an error is worth retrying. 429/5xx/network(0) yes; other 4xx no. */
export function isRetryableError(code: string, status: number): boolean {
  if (NON_RETRYABLE_CODES.has(code)) return false;
  if (status === 429) return true; // rate limited — back off and retry
  if (status === 0) return true; // network / timeout (CONFIG_ERROR excluded above)
  if (status >= 500) return true; // server fault / dependency unavailable
  if (status >= 400) return false; // other client errors
  return true;
}

// ── Persistence internals ────────────────────────────────────────────────────────

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

async function loadAll(): Promise<OutboxOperation[]> {
  const raw = await AsyncStorage.getItem(OUTBOX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OutboxOperation[]) : [];
  } catch {
    return [];
  }
}

// Serializes read-modify-write so concurrent mutations can't clobber the queue
// (AsyncStorage has no atomic compare-and-set). Same pattern as storage.ts.
let writeQueue: Promise<unknown> = Promise.resolve();

function mutate<T>(fn: (ops: OutboxOperation[]) => { ops: OutboxOperation[]; result: T }): Promise<T> {
  const run = writeQueue.then(async () => {
    const current = await loadAll();
    const { ops, result } = fn(current);
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(ops));
    return result;
  });
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── Read helpers (lock-free; read a committed snapshot) ──────────────────────────

export async function listAll(): Promise<OutboxOperation[]> {
  return loadAll();
}

/** One operation by id (read-only) — lets the scan queue reconcile its transport op. */
export async function getOperation(id: string): Promise<OutboxOperation | null> {
  const all = await loadAll();
  return all.find((op) => op.id === id) ?? null;
}

/** Pending operations whose backoff has elapsed, oldest first (FIFO). */
export async function listPendingDue(now: number = Date.now()): Promise<OutboxOperation[]> {
  const all = await loadAll();
  return all
    .filter((op) => op.status === 'pending' && Date.parse(op.next_attempt_at) <= now)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function listDeadLetters(): Promise<OutboxOperation[]> {
  const all = await loadAll();
  return all.filter((op) => op.status === 'dead_letter');
}

// ── Enqueue ──────────────────────────────────────────────────────────────────────

async function enqueue(
  fields: Pick<OutboxOperation, 'type' | 'payload'>,
  opts: EnqueueOptions,
): Promise<OutboxOperation> {
  const ts = isoAt(opts.now ?? Date.now());
  const op = {
    id: opts.id ?? uuidv4(),
    idempotencyKey: opts.idempotencyKey ?? uuidv4(),
    correlationId: opts.correlationId ?? uuidv4(),
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: ts, // due immediately
    last_error_code: null,
    last_error_message: null,
    result: null,
    created_at: ts,
    updated_at: ts,
    ...fields,
  } as OutboxOperation;
  await mutate((ops) => ({ ops: [...ops, op], result: undefined }));
  return op;
}

export function enqueueCreateIngestion(
  payload: CreateIngestionPayload,
  opts: EnqueueOptions = {},
): Promise<CreateIngestionOperation> {
  return enqueue({ type: 'create_ingestion', payload }, opts) as Promise<CreateIngestionOperation>;
}

export function enqueuePollIngestionStatus(
  payload: PollIngestionStatusPayload,
  opts: EnqueueOptions = {},
): Promise<PollIngestionStatusOperation> {
  return enqueue({ type: 'poll_ingestion_status', payload }, opts) as Promise<PollIngestionStatusOperation>;
}

export function enqueueOverrideField(
  payload: OverrideFieldPayload,
  opts: EnqueueOptions = {},
): Promise<OverrideFieldOperation> {
  return enqueue({ type: 'override_field', payload }, opts) as Promise<OverrideFieldOperation>;
}

export function enqueueConfirmIngestion(
  payload: ConfirmIngestionPayload,
  opts: EnqueueOptions = {},
): Promise<ConfirmIngestionOperation> {
  return enqueue({ type: 'confirm_ingestion', payload }, opts) as Promise<ConfirmIngestionOperation>;
}

export function enqueueFinalizeReview(
  payload: FinalizeReviewPayload,
  opts: EnqueueOptions = {},
): Promise<FinalizeReviewOperation> {
  return enqueue({ type: 'finalize_review', payload }, opts) as Promise<FinalizeReviewOperation>;
}

// ── Status transitions ─────────────────────────────────────────────────────────

/** Claim a pending op for execution. No-op (returns null) if not pending/found. */
export function markInFlight(id: string, now: number = Date.now()): Promise<OutboxOperation | null> {
  return mutate((ops) => {
    let updated: OutboxOperation | null = null;
    const next = ops.map((op) => {
      if (op.id === id && op.status === 'pending') {
        updated = { ...op, status: 'in_flight', updated_at: isoAt(now) };
        return updated;
      }
      return op;
    });
    return { ops: next, result: updated };
  });
}

/**
 * Mark an in-flight/pending op succeeded, optionally recording its result (e.g.
 * the ingestion_id) for a later batch. Returns null if not found.
 */
export function markSucceeded(
  id: string,
  opts: { result?: OutboxResult; now?: number } = {},
): Promise<OutboxOperation | null> {
  const now = opts.now ?? Date.now();
  return mutate((ops) => {
    let updated: OutboxOperation | null = null;
    const next = ops.map((op) => {
      if (op.id === id && (op.status === 'in_flight' || op.status === 'pending')) {
        updated = {
          ...op,
          status: 'succeeded',
          result: opts.result ?? op.result,
          updated_at: isoAt(now),
        };
        return updated;
      }
      return op;
    });
    return { ops: next, result: updated };
  });
}

/**
 * Record a failed attempt: increment attempt_count, store the error, and either
 * schedule a backed-off retry or move to dead_letter (non-retryable error or
 * attempts exhausted). Returns the updated op, or null if not found/active.
 */
export function markFailed(
  id: string,
  error: OperationError,
  now: number = Date.now(),
): Promise<OutboxOperation | null> {
  return mutate((ops) => {
    let updated: OutboxOperation | null = null;
    const next = ops.map((op) => {
      if (op.id !== id || (op.status !== 'in_flight' && op.status !== 'pending')) return op;

      const attempt_count = op.attempt_count + 1;
      const retriable = error.retriable ?? isRetryableError(error.code, error.status);
      const exhausted = attempt_count >= MAX_ATTEMPTS;
      const toDeadLetter = !retriable || exhausted;

      updated = {
        ...op,
        attempt_count,
        status: toDeadLetter ? 'dead_letter' : 'pending',
        next_attempt_at: toDeadLetter ? isoAt(now) : isoAt(now + backoffDelayMs(attempt_count)),
        last_error_code: error.code,
        last_error_message: error.message ? error.message.slice(0, MAX_ERROR_MESSAGE_LEN) : null,
        updated_at: isoAt(now),
      };
      return updated;
    });
    return { ops: next, result: updated };
  });
}

/**
 * Purge terminal ops so the queue cannot grow without bound (every scan enqueues
 * ops that would otherwise live in AsyncStorage forever). Removes:
 *  - `succeeded` ops older than `succeededAfterMs` (kept a while for diagnostics —
 *    create_ingestion results are read shortly after success, never days later);
 *  - `dead_letter` ops older than `deadLetterAfterMs` (kept longer: they represent
 *    lost writes an operator might still requeue).
 * Pending / in-flight ops are NEVER touched. Returns the number removed.
 */
export function purgeTerminalOps(
  opts: { succeededAfterMs?: number; deadLetterAfterMs?: number; now?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const succeededAfterMs = opts.succeededAfterMs ?? 24 * 60 * 60 * 1_000; // 1 day
  const deadLetterAfterMs = opts.deadLetterAfterMs ?? 14 * 24 * 60 * 60 * 1_000; // 14 days
  return mutate((ops) => {
    const keep = ops.filter((op) => {
      const age = now - Date.parse(op.updated_at);
      if (op.status === 'succeeded') return age < succeededAfterMs;
      if (op.status === 'dead_letter') return age < deadLetterAfterMs;
      return true; // pending / in_flight always kept
    });
    return { ops: keep, result: ops.length - keep.length };
  });
}

/** Manually return a dead-lettered op to the pending queue with a fresh budget. */
export function requeueDeadLetter(id: string, now: number = Date.now()): Promise<OutboxOperation | null> {
  return mutate((ops) => {
    let updated: OutboxOperation | null = null;
    const next = ops.map((op) => {
      if (op.id === id && op.status === 'dead_letter') {
        updated = {
          ...op,
          status: 'pending',
          attempt_count: 0,
          next_attempt_at: isoAt(now),
          last_error_code: null,
          last_error_message: null,
          updated_at: isoAt(now),
        };
        return updated;
      }
      return op;
    });
    return { ops: next, result: updated };
  });
}
