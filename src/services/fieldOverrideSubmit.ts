/**
 * Foreground submission of human field corrections (audit §4.2).
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
 * GS1-owned fields (lot/DLC/weight/GTIN/packaging) are exact and NOT human-editable — the
 * backend rejects them (409) and we skip them client-side so they never dead-letter.
 */

import { ApiError, overrideField } from './api';
import {
  enqueueOverrideField,
  markFailed,
  markInFlight,
  markSucceeded,
  type OperationError,
} from './outbox';

// Mirror of the backend GS1_OWNED_FIELDS (override_field.py): these come from the
// barcode symbology and are never overridable by a human.
const GS1_OWNED_FIELDS = new Set<string>([
  'batch_number',
  'expiry_date',
  'weight',
  'gtin',
  'packaging_date',
]);

/** A field a reviewer may push to the backend (anything that isn't GS1-exact). */
export function isHumanEditableField(fieldName: string): boolean {
  return !GS1_OWNED_FIELDS.has(fieldName);
}

export interface FieldCorrection {
  field_name: string;
  value: string | null; // null => the reviewer cleared the field
}

export interface SubmitOverridesResult {
  submitted: number; // corrections that reached the backend this call
  pending: number; // left on the outbox for a later drain (transient failure)
  skipped: number; // GS1-owned / non-editable, never sent
}

function toOperationError(err: unknown): OperationError {
  if (err instanceof ApiError) {
    return { code: err.code, status: err.status, message: err.message, retriable: err.retriable };
  }
  return { code: 'UNKNOWN', status: 0, message: 'unexpected client error', retriable: true };
}

/**
 * Push each editable correction to the backend, best-effort. Never throws: callers can
 * fire-and-forget after the local save without risking the UI flow.
 */
export async function submitFieldOverrides(input: {
  ingestionId: string;
  fields: FieldCorrection[];
}): Promise<SubmitOverridesResult> {
  const result: SubmitOverridesResult = { submitted: 0, pending: 0, skipped: 0 };

  for (const field of input.fields) {
    if (!isHumanEditableField(field.field_name)) {
      result.skipped += 1;
      continue;
    }

    const op = await enqueueOverrideField({
      ingestion_id: input.ingestionId,
      field_name: field.field_name,
      value: field.value,
    });

    const claimed = await markInFlight(op.id);
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
        { idempotencyKey: claimed.idempotencyKey, correlationId: claimed.correlationId },
      );
      await markSucceeded(claimed.id);
      result.submitted += 1;
    } catch (err) {
      await markFailed(claimed.id, toOperationError(err));
      result.pending += 1;
    }
  }

  return result;
}
