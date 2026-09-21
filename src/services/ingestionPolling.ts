/**
 * Foreground polling of GET /v1/ingestions/{id} (Batch 7), behind backend_first.
 *
 * Long-poll first (Tier 4): after the first immediate GET establishes a baseline
 * status, each subsequent request asks the SERVER to hold until the status changes
 * (`wait` + `last_status`) — transitions (raw_stored → ocr_done → terminal) are
 * learned with ~0 discovery latency instead of the ~1 s poll cadence. Anti-spin
 * fallback: if a long-poll comes back UNCHANGED almost instantly (an older server
 * ignoring the params), the loop reverts to the classic paced cadence — never a
 * hot loop against the backend.
 *
 * Bounded: stops at a review-ready/terminal status, or after a max duration / max
 * attempts — it NEVER polls forever. Cancellable via an AbortSignal so a screen
 * unmount aborts the in-flight request and the loop. No setState here: it returns
 * a typed PollResult for the caller to act on (after confirming it's still mounted).
 */

import { ApiError, getIngestionStatus } from './api';
import type { IngestionStatus, IngestionStatusResponse } from '../types/api';

export type PollResult =
  | { kind: 'review_ready'; ingestion: IngestionStatusResponse }
  | { kind: 'failed'; status: IngestionStatus; ingestion: IngestionStatusResponse }
  | { kind: 'timeout' } // bounded polling exhausted while still processing
  | { kind: 'aborted' } // cancelled (e.g. screen unmounted)
  | { kind: 'error'; code: string; message: string };

export interface PollOptions {
  signal?: AbortSignal;
  maxDurationMs?: number; // overall budget (default 30s)
  maxAttempts?: number; // hard attempt cap (default 24)
  baseDelayMs?: number; // flat inter-attempt delay in the fast window (default 1s)
  maxDelayMs?: number; // delay cap once we back off (default 5s)
  requestTimeoutMs?: number; // per-GET timeout (default 10s; added ON TOP of a long-poll hold)
  /**
   * Tier 4: server-side hold per request, in seconds (default 25 — the server cap).
   * 0 disables long-polling entirely (classic ~1 s cadence).
   */
  longPollSeconds?: number;
  /**
   * Tier 3 wave 2: fired (at most once per state change) when a poll sees the
   * intermediate `ocr_done` status — the OCR is finished, the LLM is still running,
   * and `ingestion.interim_fields` may carry deterministic preview values. The loop
   * KEEPS polling after this callback; it never affects the terminal result.
   */
  onInterim?: (ingestion: IngestionStatusResponse) => void;
}

type StatusClass = 'processing' | 'review_ready' | 'failed' | 'unknown';

// Mirror of the backend's 12-state machine (ingestion/domain/status.py) — every status
// the server can hold MUST classify, else a legitimate state surfaces as an error.
//
// Non-terminal: keep polling. `raw_stored` = accepted, `ocr_running`/`extraction_running`
// = worker mid-flight, `ocr_done` = Tier 3 transit (carries the wave-2 interim payload);
// processing/extracting/pending accepted defensively for future server versions.
const PROCESSING = new Set<string>([
  'raw_stored',
  'ocr_running',
  'ocr_done',
  'extraction_running',
  'processing',
  'extracting',
  'pending',
]);
// Review-ready: fields exist (latest_fields), the Review screen can render/edit.
// `ocr_skipped_garbage`: illegible image, LLM skipped — GS1 fields still present.
// `confirmed`: a REPLAYED scan of an already-reviewed label (submit dedups on the
// content hash) — the fields exist and must show, never an "unknown status" error.
const REVIEW_READY = new Set<string>([
  'extracted',
  'needs_review',
  'ocr_skipped_garbage',
  'confirmed',
]);
// Terminal failures: the operator retakes the photo. `rejected` and
// `halted_missing_context` are reviewer/system terminal rejections — same recovery.
const FAILED = new Set<string>([
  'extraction_failed',
  'ocr_failed',
  'rejected',
  'halted_missing_context',
]);

export function classifyIngestionStatus(status: string): StatusClass {
  if (REVIEW_READY.has(status)) return 'review_ready';
  if (FAILED.has(status)) return 'failed';
  if (PROCESSING.has(status)) return 'processing';
  return 'unknown';
}

// A label extraction (OCR + Haiku) almost always lands in < 12 s. Poll on a FAST,
// FLAT cadence in that window so the result is shown within ~1 s of being ready —
// exponential backoff here only adds dead time staring at skeletons (audit §1.2).
// Past that window (a genuinely slow extraction) we back off to spare the network.
// (Only reached when long-polling is disabled or the server ignores it — Tier 4.)
const FLAT_WINDOW_ATTEMPTS = 12;

// Anti-spin threshold (Tier 4): a long-poll that returns UNCHANGED faster than this
// did not actually hold server-side (older server ignoring wait/last_status) — fall
// back to the paced cadence instead of hammering the endpoint.
const MIN_LONG_POLL_MS = 750;

function backoffDelayMs(attempt: number, base: number, max: number): number {
  if (attempt <= FLAT_WINDOW_ATTEMPTS) {
    // small jitter so concurrent clients don't align their polls
    return base + Math.round(Math.random() * base * 0.2);
  }
  const exp = Math.min(base * 2 ** (attempt - FLAT_WINDOW_ATTEMPTS), max);
  return Math.min(Math.round(exp), max);
}

function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function pollIngestionUntilReady(
  ingestionId: string,
  options: PollOptions = {},
): Promise<PollResult> {
  const {
    signal,
    maxDurationMs = 30_000,
    maxAttempts = 24,
    baseDelayMs = 1_000,
    maxDelayMs = 5_000,
    requestTimeoutMs = 10_000,
    longPollSeconds = 25,
    onInterim,
  } = options;

  const start = Date.now();
  let attempt = 0;
  // Long-poll baseline (Tier 4): null until the first (immediate) GET establishes
  // the status the server should hold against. `longPollTrusted` drops to false if
  // the server proves it ignores the hold (anti-spin) — classic pacing from there.
  let lastStatus: string | null = null;
  let longPollTrusted = longPollSeconds > 0;
  // Dedupe the interim notification: the payload is written once server-side (a single
  // interim commit per ingestion), so one key on status+count means the callback fires
  // once instead of on every poll.
  let interimNotifiedKey: string | null = null;

  while (!signal?.aborted && attempt < maxAttempts && Date.now() - start < maxDurationMs) {
    attempt += 1;
    // Hold budget for THIS request: never past the loop's own remaining budget.
    const remainingS = Math.floor((maxDurationMs - (Date.now() - start)) / 1000);
    const waitS =
      longPollTrusted && lastStatus != null
        ? Math.max(0, Math.min(longPollSeconds, remainingS))
        : 0;
    const requestStartedAt = Date.now();
    try {
      const ingestion = await getIngestionStatus(ingestionId, {
        signal,
        // The HTTP timeout must OUTLIVE the server-side hold, else every long-poll
        // that runs to expiry would surface as a spurious TIMEOUT error.
        timeoutMs: waitS * 1000 + requestTimeoutMs,
        waitSeconds: waitS > 0 ? waitS : undefined,
        lastStatus: waitS > 0 && lastStatus != null ? lastStatus : undefined,
      });
      const cls = classifyIngestionStatus(ingestion.status);
      if (cls === 'review_ready') return { kind: 'review_ready', ingestion };
      if (cls === 'failed') return { kind: 'failed', status: ingestion.status, ingestion };
      if (onInterim && ingestion.status === 'ocr_done') {
        const key = `ocr_done:${ingestion.interim_fields?.length ?? 0}`;
        if (key !== interimNotifiedKey) {
          interimNotifiedKey = key;
          onInterim(ingestion);
        }
      }
      if (cls === 'unknown') {
        return {
          kind: 'error',
          code: 'UNKNOWN_STATUS',
          message: `unexpected ingestion status: ${ingestion.status}`,
        };
      }
      // 'processing' → loop again. With a trusted long-poll the server does the
      // waiting, so re-request IMMEDIATELY. Anti-spin: an UNCHANGED status that
      // came back near-instantly means the server did not actually hold (older
      // server ignoring the params) — stop trusting it and pace classically.
      const unchanged = ingestion.status === lastStatus;
      lastStatus = ingestion.status;
      if (waitS > 0 && unchanged && Date.now() - requestStartedAt < MIN_LONG_POLL_MS) {
        longPollTrusted = false;
      }
      if (longPollTrusted) continue;
    } catch (err) {
      if (signal?.aborted) return { kind: 'aborted' };
      // Retry only transient failures (network/timeout/5xx); fail fast otherwise.
      const retriable = err instanceof ApiError ? err.retriable : false;
      if (!retriable) {
        return {
          kind: 'error',
          code: err instanceof ApiError ? err.code : 'UNKNOWN',
          message: err instanceof ApiError ? err.message : 'failed to fetch ingestion status',
        };
      }
    }
    await cancellableDelay(backoffDelayMs(attempt, baseDelayMs, maxDelayMs), signal);
  }

  if (signal?.aborted) return { kind: 'aborted' };
  return { kind: 'timeout' };
}
