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
 *   - create_ingestion ops are drained too (workflow v1): their file URIs point at
 *     the DURABLE pending/ photo store, so a replay is sound; after each drain the
 *     scan queue reconciles so a landed submit advances its card.
 */

import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

import {
  ApiError,
  confirmIngestion,
  createIngestion,
  finalizeReview,
  overrideField,
} from './api';
import {
  listPendingDue,
  markFailed,
  markInFlight,
  markSucceeded,
  operationMatchesOperatorContext,
  purgeTerminalOps,
  type OperationError,
  type OutboxOperation,
  type OutboxResult,
} from './outbox';
import { reconcileScanQueue } from './scanQueue';
import { getOperatorContext } from './authStorage';

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

type ExecuteOutcome =
  | { handled: false }
  | { handled: true; result?: OutboxResult }; // result recorded on the op (create_ingestion)

async function executeOperation(op: OutboxOperation): Promise<ExecuteOutcome> {
  if (op.type === 'override_field') {
    await overrideField(op.payload.ingestion_id, op.payload.field_name, op.payload.value, op.payload.note, {
      idempotencyKey: op.idempotencyKey,
      correlationId: op.correlationId,
      forceGs1: op.payload.force_gs1,
    });
    return { handled: true };
  }
  if (op.type === 'confirm_ingestion') {
    await confirmIngestion(op.payload.ingestion_id, {
      idempotencyKey: op.idempotencyKey,
      correlationId: op.correlationId,
    });
    return { handled: true };
  }
  if (op.type === 'finalize_review') {
    await finalizeReview(
      op.payload.ingestion_id,
      op.payload.fields,
      op.payload.note,
      op.payload.photo_rotation_degrees ?? 0,
      op.payload.photo_base_rotation_degrees ?? -90,
      {
        idempotencyKey: op.idempotencyKey,
        correlationId: op.correlationId,
      },
    );
    return { handled: true };
  }
  if (op.type === 'create_ingestion') {
    const res = await createIngestion(
      op.payload.file,
      {
        barcode_raw: op.payload.barcode_raw,
        client_captured_at: op.payload.client_captured_at,
      },
      { idempotencyKey: op.idempotencyKey, correlationId: op.correlationId },
    );
    // The ingestion_id must land on the op — reconcileScanQueue reads it there.
    return {
      handled: true,
      result: { ingestion_id: res.ingestion_id, status: res.status, replayed: res.replayed },
    };
  }
  return { handled: false };
}

// One drain at a time. A trigger that arrives WHILE a drain is running does not get
// lost: it flags a trailing re-pass, so an op enqueued mid-drain (e.g. the confirm of
// a save landing during the foreground drain) goes out immediately, not "next time".
let draining = false;
let rerunRequested = false;
let drainWaiters: Array<() => void> = [];

/** Drain due review writes. Never throws — safe to fire-and-forget. */
export async function drainOutbox(now: number = Date.now()): Promise<DrainResult> {
  const result: DrainResult = { succeeded: 0, failed: 0, skipped: 0 };
  if (draining) {
    rerunRequested = true;
    // A save action needs to know the state AFTER its operation has had a chance
    // to run. Waiting for the active drain (including the trailing re-pass requested
    // above) avoids reporting a false, blocking "En attente de synchronisation" while
    // another foreground/network-triggered drain is already sending the review.
    await new Promise<void>((resolve) => drainWaiters.push(resolve));
    return result;
  }
  draining = true;
  try {
    do {
      rerunRequested = false;
      // Fresh clock each pass: an op enqueued MID-drain has next_attempt_at after
      // the drain's start time — a frozen `now` would never see it due.
      const due = await listPendingDue(Math.max(now, Date.now()));
      const operatorContext = await getOperatorContext();
      for (const op of due) {
        if (
          op.type !== 'override_field' &&
          op.type !== 'confirm_ingestion' &&
          op.type !== 'finalize_review' &&
          op.type !== 'create_ingestion'
        ) {
          result.skipped += 1;
          continue;
        }
        if (!operationMatchesOperatorContext(op, operatorContext)) {
          result.skipped += 1;
          continue;
        }
        const claimed = await markInFlight(op.id);
        if (!claimed) continue; // raced by another executor — skip
        try {
          const exec = await executeOperation(claimed);
          await markSucceeded(claimed.id, exec.handled && exec.result ? { result: exec.result } : {});
          result.succeeded += 1;
        } catch (err) {
          await markFailed(claimed.id, toOperationError(err));
          result.failed += 1;
        }
      }
      // Keep housekeeping inside the coalescing loop. If another trigger arrives
      // while this storage write is in progress, rerunRequested stays observable by
      // the loop and its newly queued review cannot miss the trailing pass.
      await purgeTerminalOps({ now });
    } while (rerunRequested);
  } catch {
    // Storage failure reading the queue — nothing to do; the next trigger retries.
  } finally {
    draining = false;
    rerunRequested = false;
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  }
  // A landed create_ingestion must advance its scan card (step 1 → 2). Fire-and-forget
  // AFTER the latch released — reconciliation may schedule polls, never another drain.
  if (result.succeeded > 0) void reconcileScanQueue();
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
  const unsubscribeNetwork = NetInfo.addEventListener((state) => {
    if (state.isConnected && state.isInternetReachable !== false) {
      void drainOutbox();
    }
  });
  // Also drain once at registration (app just started — same plausibility).
  void drainOutbox();
  return () => {
    sub.remove();
    unsubscribeNetwork();
  };
}
