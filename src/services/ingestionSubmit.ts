/**
 * Foreground submission of a backend_first capture (Batch 6).
 *
 * Bridges the outbox (durable per-capture operation + stable Idempotency-Key /
 * X-Correlation-Id) and the API client. It enqueues a `create_ingestion` op, then
 * executes it ONCE in the foreground and records the outcome on the op:
 *  - success      → op marked succeeded, the ingestion_id stored on the op
 *  - retryable    → op left pending with a backed-off next_attempt_at (a later
 *                   batch drains it; there is no background worker yet)
 *  - non-retryable/exhausted → op moved to dead_letter
 *
 * No polling, no background worker, no secrets.
 */

import { ApiError, createIngestion } from './api';
import {
  enqueueCreateIngestion,
  markFailed,
  markInFlight,
  markSucceeded,
  type CreateIngestionPayload,
  type OperationError,
} from './outbox';

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

export async function submitCapture(input: CaptureInput): Promise<SubmitOutcome> {
  const payload: CreateIngestionPayload = {
    file: { uri: input.fileUri, name: 'label.jpg', type: 'image/jpeg' },
    barcode_raw: input.barcodeRaw,
    client_captured_at: input.capturedAt,
  };
  const op = await enqueueCreateIngestion(payload);

  const claimed = await markInFlight(op.id);
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
