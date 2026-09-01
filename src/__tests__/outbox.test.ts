jest.mock('../services/authStorage', () => ({
  captureActiveSession: jest.fn(async () => ({
    generation: 1,
    scopeKey: 'org-a:actor-a:portal-a:boucherie',
    signal: new AbortController().signal,
  })),
  getOperatorContext: jest.fn(async () => ({
    organizationId: 'org-a',
    actorId: 'actor-a',
    businessPortalId: 'portal-a',
    tradeCode: 'boucherie',
  })),
  isSessionFenceCurrent: jest.fn(() => true),
  operatorContextKey: jest.fn((context) =>
    [context.organizationId, context.actorId, context.businessPortalId, context.tradeCode].join(':'),
  ),
}));

import {
  _resetOutboxRuntimeForTests,
  backoffDelayMs,
  clearOutbox as purgeOutbox,
  enqueueFinalizeReview,
  isRetryableError,
  listAll,
  listPendingDue,
  markFailed,
  markInFlight,
  MAX_ATTEMPTS,
  operationMatchesOperatorContext,
  recoverInterruptedInFlight,
  updatePendingFinalizeReview,
} from '../services/outbox';

async function clearOutbox() {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  await AsyncStorage.multiRemove(['@labelscan:outbox', '@labelscan:outbox:v2']);
}

beforeEach(async () => {
  _resetOutboxRuntimeForTests();
  await clearOutbox();
});

describe('outbox backoff', () => {
  it('first attempt delay is at least base', () => {
    const delay = backoffDelayMs(1, 100, 60_000);
    expect(delay).toBeGreaterThanOrEqual(100);
  });

  it('caps at maxMs', () => {
    const delay = backoffDelayMs(20, 100, 500);
    expect(delay).toBeLessThanOrEqual(500);
  });

  it('grows exponentially', () => {
    const d1 = backoffDelayMs(1, 100, 60_000);
    const d3 = backoffDelayMs(3, 100, 60_000);
    expect(d3).toBeGreaterThan(d1);
  });
});

describe('isRetryableError', () => {
  it('retries 5xx', () => {
    expect(isRetryableError('INTERNAL_ERROR', 500)).toBe(true);
  });

  it('retries 429', () => {
    expect(isRetryableError('RATE_LIMITED', 429)).toBe(true);
  });

  it('retries network errors (status 0)', () => {
    expect(isRetryableError('NETWORK_ERROR', 0)).toBe(true);
  });

  it('does not retry 400 client errors', () => {
    expect(isRetryableError('VALIDATION_ERROR', 400)).toBe(false);
  });

  it('does not retry 401 UNAUTHENTICATED', () => {
    expect(isRetryableError('UNAUTHENTICATED', 401)).toBe(false);
  });

  it('does not retry 403 FORBIDDEN', () => {
    expect(isRetryableError('FORBIDDEN', 403)).toBe(false);
  });

  it('does not retry PAYLOAD_TOO_LARGE', () => {
    expect(isRetryableError('PAYLOAD_TOO_LARGE', 413)).toBe(false);
  });
});

describe('MAX_ATTEMPTS', () => {
  it('is 5', () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });
});

describe('local operator ownership', () => {
  const owned = {
    schema_version: 2,
    owner_organization_id: 'org-a',
    owner_actor_id: 'actor-a',
    owner_business_portal_id: 'portal-a',
    owner_trade_code: 'boucherie',
  } as never;

  it('allows the exact server context and blocks another portal', () => {
    expect(
      operationMatchesOperatorContext(owned, {
        organizationId: 'org-a',
        actorId: 'actor-a',
        businessPortalId: 'portal-a',
        tradeCode: 'boucherie',
      }),
    ).toBe(true);
    expect(
      operationMatchesOperatorContext(owned, {
        organizationId: 'org-a',
        actorId: 'actor-a',
        businessPortalId: 'portal-b',
        tradeCode: 'boucherie',
      }),
    ).toBe(false);
    expect(operationMatchesOperatorContext(owned, null)).toBe(false);
  });

  it('rejects unowned historical operations', () => {
    expect(operationMatchesOperatorContext({} as never, null)).toBe(false);
  });
});

describe('pending review updates', () => {
  it('recovers a killed-process in-flight operation with the same stable keys', async () => {
    const operation = await enqueueFinalizeReview(
      {
        ingestion_id: 'ing-interrupted',
        fields: { commercial_designation: 'Saumon' },
      },
      {
        id: 'op-stable',
        idempotencyKey: 'idem-stable',
        correlationId: 'corr-stable',
      },
    );
    await markInFlight(operation.id);

    // A live request in this process keeps its lease.
    await expect(recoverInterruptedInFlight()).resolves.toBe(0);
    expect((await listAll())[0].status).toBe('in_flight');

    // Cold restart: memory lease is gone, durable row remains safe to replay.
    _resetOutboxRuntimeForTests();
    await expect(recoverInterruptedInFlight()).resolves.toBe(1);
    expect((await listAll())[0]).toMatchObject({
      id: 'op-stable',
      idempotencyKey: 'idem-stable',
      correlationId: 'corr-stable',
      status: 'pending',
      last_error_code: 'INTERRUPTED',
    });
  });

  it('serializes logout purge behind an already-started persistence write', async () => {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const setItem = jest.mocked(AsyncStorage.setItem);
    const originalSetItem = setItem.getMockImplementation();
    let releaseWrite!: () => void;
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    setItem.mockImplementationOnce(async (key, value) => {
      signalWriteStarted();
      await writeGate;
      await originalSetItem?.(key, value);
    });

    const enqueue = enqueueFinalizeReview({
      ingestion_id: 'ing-race',
      fields: { commercial_designation: 'Saumon' },
    });
    await writeStarted;
    const purge = purgeOutbox();
    releaseWrite();
    await Promise.all([enqueue, purge]);

    expect(await listAll()).toEqual([]);
  });

  it('keeps the manager-approved photo orientation before a retry is sent', async () => {
    const operation = await enqueueFinalizeReview({
      ingestion_id: 'ing-1',
      fields: { commercial_designation: 'Saumon' },
      photo_rotation_degrees: 0,
    });

    const updated = await updatePendingFinalizeReview(operation.id, {
      ingestion_id: 'ing-1',
      fields: { commercial_designation: 'Saumon' },
      photo_rotation_degrees: 180,
    });

    expect(updated?.payload.photo_rotation_degrees).toBe(180);
    expect((await listAll())[0]).toMatchObject({
      payload: { photo_rotation_degrees: 180 },
    });
  });

  it('makes a backed-off review immediately due after an explicit retry', async () => {
    const firstAttemptAt = Date.parse('2026-08-21T10:00:00.000Z');
    const retryAt = firstAttemptAt + 1_000;
    const operation = await enqueueFinalizeReview(
      {
        ingestion_id: 'ing-1',
        fields: { commercial_designation: 'Saumon' },
      },
      { now: firstAttemptAt },
    );
    await markInFlight(operation.id, firstAttemptAt);
    await markFailed(
      operation.id,
      { code: 'NETWORK_ERROR', status: 0, retriable: true },
      firstAttemptAt,
    );
    expect(await listPendingDue(retryAt)).toHaveLength(0);

    await updatePendingFinalizeReview(
      operation.id,
      {
        ingestion_id: 'ing-1',
        fields: { commercial_designation: 'Saumon' },
      },
      retryAt,
    );

    expect((await listPendingDue(retryAt)).map((op) => op.id)).toEqual([operation.id]);
  });
});
