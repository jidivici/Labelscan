/**
 * Foreground submission of human field corrections (audit §4.2, workflow v1).
 *
 * After a reviewer saves an arrivage locally, each EDITED field is pushed to the
 * AUTHORITATIVE backend store via PATCH /v1/ingestions/{id}/fields/{name} so the server
 * holds the human-validated value (append-only, source='human') — closing the gap where
 * corrections lived only in the device's AsyncStorage.
 *
 * Resilience mirrors ingestionSubmit: each correction is enqueued on the durable local
 * outbox (stable Idempotency-Key / X-Correlation-Id) and executed ONCE in the foreground.
 * A transient failure leaves the op pending for a later drain; a non-retryable one
 * dead-letters. Best-effort: it never throws, so a sync hiccup never blocks the save.
 *
 * The operator stays in charge of all active profile fields, including GS1-owned ones
 * (lot/DLC/weight/GTIN/packaging) — those are sent with the explicit `force_gs1` flag so
 * the server records the override under a dedicated, auditable action instead of
 * rejecting it (server override_field.py). Without the flag those fields still 409.
 */

import { ApiError, overrideField } from './api';
import {
  enqueueOverrideField,
  markFailed,
  markInFlight,
  markSucceeded,
  type OperationError,
} from './outbox';
import { captureActiveSession, isSessionFenceCurrent } from './authStorage';

// Mirror of the backend GS1_OWNED_FIELDS (override_field.py): these come from the
// barcode symbology — overriding them is flagged explicitly (force_gs1) so the server
// audits the correction under its own action rather than silently accepting it.
const GS1_OWNED_FIELDS = new Set<string>([
  'batch_number',
  'expiry_date',
  'weight',
  'gtin',
  'packaging_date',
]);

export function isGs1OwnedField(fieldName: string): boolean {
  return GS1_OWNED_FIELDS.has(fieldName);
}

export interface FieldCorrection {
  field_name: string;
  value: string | null; // null => the reviewer cleared the field
}

export interface SubmitOverridesResult {
  submitted: number; // corrections that reached the backend this call
  pending: number; // left on the outbox for a later drain (transient failure, or 409 without the flag on an old server)
}

function toOperationError(err: unknown): OperationError {
  if (err instanceof ApiError) {
    return { code: err.code, status: err.status, message: err.message, retriable: err.retriable };
  }
  return { code: 'UNKNOWN', status: 0, message: 'unexpected client error', retriable: true };
}

/**
 * Push each correction to the backend, best-effort. Never throws: callers can
 * fire-and-forget after the local save without risking the UI flow.
 */
export async function submitFieldOverrides(input: {
  ingestionId: string;
  fields: FieldCorrection[];
}): Promise<SubmitOverridesResult> {
  const result: SubmitOverridesResult = { submitted: 0, pending: 0 };
  const fence = await captureActiveSession();
  if (!fence) return { submitted: 0, pending: input.fields.length };

  for (const [index, field] of input.fields.entries()) {
    if (!isSessionFenceCurrent(fence)) {
      result.pending += input.fields.length - index;
      break;
    }
    const forceGs1 = isGs1OwnedField(field.field_name);
    let op;
    try {
      op = await enqueueOverrideField({
        ingestion_id: input.ingestionId,
        field_name: field.field_name,
        value: field.value,
        force_gs1: forceGs1 || undefined,
      });
    } catch {
      result.pending += 1;
      continue;
    }

    if (!isSessionFenceCurrent(fence)) {
      result.pending += input.fields.length - index;
      break;
    }
    const claimed = await markInFlight(op.id, Date.now(), fence);
    if (!claimed || claimed.type !== 'override_field') {
      result.pending += 1;
      continue;
    }

    try {
      await overrideField(
        claimed.payload.ingestion_id,
        claimed.payload.field_name,
        claimed.payload.value,
        claimed.payload.note,
        {
          idempotencyKey: claimed.idempotencyKey,
          correlationId: claimed.correlationId,
          forceGs1: claimed.payload.force_gs1,
          signal: fence.signal,
        },
      );
      if (!isSessionFenceCurrent(fence)) {
        result.pending += 1;
        continue;
      }
      await markSucceeded(claimed.id, { fence });
      result.submitted += 1;
    } catch (err) {
      if (isSessionFenceCurrent(fence)) {
        await markFailed(claimed.id, toOperationError(err), Date.now(), fence);
      }
      result.pending += 1;
    }
  }

  return result;
}
