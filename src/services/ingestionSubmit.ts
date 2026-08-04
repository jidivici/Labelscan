/**
 * Submission of a backend_first capture (Batch 6, reshaped for workflow v1).
 *
 * Bridges the outbox (durable per-capture operation + stable Idempotency-Key /
 * X-Correlation-Id) and the API client, split in two so the scan QUEUE can record
 * the op id BEFORE the (slow) HTTP attempt — a kill mid-upload leaves a scan that
 * reconciliation can still resolve from its op:
 *  - enqueueCapture   → persist the durable `create_ingestion` op, return it
 *  - executeCreateIngestionOp → claim + POST once, record the outcome on the op:
 *      success      → op marked succeeded, the ingestion_id stored on the op
 *      retryable    → op left pending with a backed-off next_attempt_at (the
 *                     outbox drain replays it later)
 *      non-retryable/exhausted → op moved to dead_letter
 *
 * No polling, no secrets.
 */

import { ApiError, createIngestion } from './api';
import {
  enqueueCreateIngestion,
  getOperation,
  markFailed,
  markInFlight,
  markSucceeded,
  operationMatchesOperatorContext,
  type CreateIngestionOperation,
  type CreateIngestionPayload,
  type OperationError,
} from './outbox';
import { getOperatorContext } from './authStorage';

export type SubmitOutcome =
  | { kind: 'succeeded'; ingestionId: string; replayed: boolean }
  | { kind: 'pending'; code: string } // retryable failure — op left pending for later
  | { kind: 'dead_letter'; code: string; message: string };

export interface CaptureInput {
  fileUri: string; // image to submit — cropped to the capture frame (full image as fallback)
  barcodeRaw?: string;
  capturedAt: string; // ISO 8601
}

function toOperationError(err: unknown): OperationError {
  if (err instanceof ApiError) {
    return { code: err.code, status: err.status, message: err.message, retriable: err.retriable };
  }
  return { code: 'UNKNOWN', status: 0, message: 'unexpected client error', retriable: true };
}

/** Persist the durable submission op (stable keys) WITHOUT executing it yet. */
export function enqueueCapture(input: CaptureInput): Promise<CreateIngestionOperation> {
  const payload: CreateIngestionPayload = {
    file: { uri: input.fileUri, name: 'label.jpg', type: 'image/jpeg' },
    barcode_raw: input.barcodeRaw,
    client_captured_at: input.capturedAt,
  };
  return enqueueCreateIngestion(payload);
}

/** Claim the op and execute it ONCE in the foreground, recording the outcome. */
export async function executeCreateIngestionOp(opId: string): Promise<SubmitOutcome> {
  const queued = await getOperation(opId);
  if (queued && !operationMatchesOperatorContext(queued, await getOperatorContext())) {
    return { kind: 'pending', code: 'CONTEXT_MISMATCH' };
  }
  const claimed = await markInFlight(opId);
  if (!claimed || claimed.type !== 'create_ingestion') {
    // Could not claim it (already terminal/claimed) — leave for a later drain.
    return { kind: 'pending', code: 'NOT_CLAIMABLE' };
  }

  try {
    const res = await createIngestion(
      claimed.payload.file,
      {
        barcode_raw: claimed.payload.barcode_raw,
        client_captured_at: claimed.payload.client_captured_at,
      },
      { idempotencyKey: claimed.idempotencyKey, correlationId: claimed.correlationId },
    );
    await markSucceeded(claimed.id, {
      result: { ingestion_id: res.ingestion_id, status: res.status, replayed: res.replayed },
    });
    return { kind: 'succeeded', ingestionId: res.ingestion_id, replayed: res.replayed };
  } catch (err) {
    const opError = toOperationError(err);
    const updated = await markFailed(claimed.id, opError);
    if (updated?.status === 'dead_letter') {
      return { kind: 'dead_letter', code: opError.code, message: opError.message ?? 'submission failed' };
    }
    return { kind: 'pending', code: opError.code };
  }
}

/** Enqueue + execute in one call (legacy shape, kept for direct submissions). */
export async function submitCapture(input: CaptureInput): Promise<SubmitOutcome> {
  const op = await enqueueCapture(input);
  return executeCreateIngestionOp(op.id);
}
