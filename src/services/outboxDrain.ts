/**
 * Outbox drain (P3) — replays pending review writes left behind by a sync hiccup.
 *
 * The save path executes overrides/confirms in the foreground, best-effort; a
 * transient failure leaves the op `pending` on the durable outbox with its STABLE
 * Idempotency-Key / X-Correlation-Id. This module drains those ops later:
 *   - on demand (after a save — pick up stragglers from previous saves too);
 *   - on app foreground (AppState active), via registerOutboxDrainOnForeground().
 *
 * Safe by construction:
 *   - the server dedups by Idempotency-Key (migration 0013), so a replay of an op
 *     that DID reach the backend replays the original outcome — never a double write;
 *   - one drain at a time (module-level latch) — concurrent triggers coalesce;
 *   - only review writes are drained (override_field / confirm_ingestion);
 *     create_ingestion ops carry device file URIs that may be stale and stay on
 *     the queue for their own dedicated flow.
 */

import { AppState, type AppStateStatus } from 'react-native';

import { ApiError, confirmIngestion, overrideField } from './api';
import {
  listPendingDue,
  markFailed,
  markInFlight,
  markSucceeded,
  purgeTerminalOps,
  type OperationError,
  type OutboxOperation,
} from './outbox';

export interface DrainResult {
  succeeded: number;
  failed: number; // failed THIS drain (left pending or dead-lettered per retry policy)
  skipped: number; // op types this drainer does not handle
}

function toOperationError(err: unknown): OperationError {
  if (err instanceof ApiError) {
    return { code: err.code, status: err.status, message: err.message, retriable: err.retriable };
  }
  return { code: 'UNKNOWN', status: 0, message: 'unexpected client error', retriable: true };
}

async function executeOperation(op: OutboxOperation): Promise<boolean> {
  // true = the drainer handles this op type (and the call succeeded when it returns).
  if (op.type === 'override_field') {
    await overrideField(op.payload.ingestion_id, op.payload.field_name, op.payload.value, op.payload.note, {
      idempotencyKey: op.idempotencyKey,
      correlationId: op.correlationId,
    });
    return true;
  }
  if (op.type === 'confirm_ingestion') {
    await confirmIngestion(op.payload.ingestion_id, {
      idempotencyKey: op.idempotencyKey,
      correlationId: op.correlationId,
    });
    return true;
  }
  return false;
}

// One drain at a time. A trigger that arrives WHILE a drain is running does not get
// lost: it flags a trailing re-pass, so an op enqueued mid-drain (e.g. the confirm of
// a save landing during the foreground drain) goes out immediately, not "next time".
let draining = false;
let rerunRequested = false;

/** Drain due review writes. Never throws — safe to fire-and-forget. */
export async function drainOutbox(now: number = Date.now()): Promise<DrainResult> {
  const result: DrainResult = { succeeded: 0, failed: 0, skipped: 0 };
  if (draining) {
    rerunRequested = true;
    return result;
  }
  draining = true;
  try {
    do {
      rerunRequested = false;
      // Fresh clock each pass: an op enqueued MID-drain has next_attempt_at after
      // the drain's start time — a frozen `now` would never see it due.
      const due = await listPendingDue(Math.max(now, Date.now()));
      for (const op of due) {
        if (op.type !== 'override_field' && op.type !== 'confirm_ingestion') {
          result.skipped += 1;
          continue;
        }
        const claimed = await markInFlight(op.id);
        if (!claimed) continue; // raced by another executor — skip
        try {
          await executeOperation(claimed);
          await markSucceeded(claimed.id);
          result.succeeded += 1;
        } catch (err) {
          await markFailed(claimed.id, toOperationError(err));
          result.failed += 1;
        }
      }
    } while (rerunRequested);
    // Housekeeping: drop old terminal ops so the queue cannot grow without bound
    // (every scan enqueues ops that would otherwise live in AsyncStorage forever).
    await purgeTerminalOps({ now });
  } catch {
    // Storage failure reading the queue — nothing to do; the next trigger retries.
  } finally {
    draining = false;
    rerunRequested = false;
  }
  return result;
}

/**
 * Drain whenever the app returns to the foreground (the moment connectivity most
 * plausibly came back). Returns an unsubscribe function. Call once at app root.
 */
export function registerOutboxDrainOnForeground(): () => void {
  const onChange = (state: AppStateStatus) => {
    if (state === 'active') void drainOutbox();
  };
  const sub = AppState.addEventListener('change', onChange);
  // Also drain once at registration (app just started — same plausibility).
  void drainOutbox();
  return () => sub.remove();
}
