/**
 * Foreground polling of GET /v1/ingestions/{id} (Batch 7), behind backend_first.
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
  | { kind: 'failed'; status: IngestionStatus }
  | { kind: 'timeout' } // bounded polling exhausted while still processing
  | { kind: 'aborted' } // cancelled (e.g. screen unmounted)
  | { kind: 'error'; code: string; message: string };

export interface PollOptions {
  signal?: AbortSignal;
  maxDurationMs?: number; // overall budget (default 30s)
  maxAttempts?: number; // hard attempt cap (default 20)
  baseDelayMs?: number; // first inter-attempt delay (default 1.5s)
  maxDelayMs?: number; // delay cap (default 5s)
  requestTimeoutMs?: number; // per-GET timeout (default 10s)
}

type StatusClass = 'processing' | 'review_ready' | 'failed' | 'unknown';

// Non-terminal statuses keep us polling. `raw_stored` is the documented "extraction
// not finished" state; processing/extracting/pending are accepted defensively in
// case the backend adds them later.
const PROCESSING = new Set<string>(['raw_stored', 'processing', 'extracting', 'pending']);
// `ocr_skipped_garbage`: the backend OCR-quality gate found the image illegible and
// skipped the LLM. It's terminal and routes to the review screen — any GS1 fields are
// present and the missing/low-confidence fields are editable there (or the user retakes).
const REVIEW_READY = new Set<string>(['extracted', 'needs_review', 'ocr_skipped_garbage']);
const FAILED = new Set<string>(['extraction_failed']);

export function classifyIngestionStatus(status: string): StatusClass {
  if (REVIEW_READY.has(status)) return 'review_ready';
  if (FAILED.has(status)) return 'failed';
  if (PROCESSING.has(status)) return 'processing';
  return 'unknown';
}

function backoffDelayMs(attempt: number, base: number, max: number): number {
  const exp = Math.min(base * 2 ** (attempt - 1), max);
  const jitter = Math.random() * base * 0.5;
  return Math.min(Math.round(exp + jitter), max);
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
    maxAttempts = 20,
    baseDelayMs = 1_500,
    maxDelayMs = 5_000,
    requestTimeoutMs = 10_000,
  } = options;

  const start = Date.now();
  let attempt = 0;

  while (!signal?.aborted && attempt < maxAttempts && Date.now() - start < maxDurationMs) {
    attempt += 1;
    try {
      const ingestion = await getIngestionStatus(ingestionId, { signal, timeoutMs: requestTimeoutMs });
      const cls = classifyIngestionStatus(ingestion.status);
      if (cls === 'review_ready') return { kind: 'review_ready', ingestion };
      if (cls === 'failed') return { kind: 'failed', status: ingestion.status };
      if (cls === 'unknown') {
        return {
          kind: 'error',
          code: 'UNKNOWN_STATUS',
          message: `unexpected ingestion status: ${ingestion.status}`,
        };
      }
      // 'processing' → fall through to a bounded backoff and retry
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
