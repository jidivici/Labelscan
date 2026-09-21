/**
 * P3 — outbox drain: pending review writes are replayed with their STABLE
 * Idempotency-Key / correlation id; failures follow the retry policy; op types the
 * drainer does not own are left untouched.
 */

import { drainOutbox } from '../services/outboxDrain';
import {
  enqueueConfirmIngestion,
  enqueueOverrideField,
  enqueuePollIngestionStatus,
  listAll,
} from '../services/outbox';
import { confirmIngestion, overrideField } from '../services/api';

jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));

jest.mock('../services/api', () => ({
  ApiError: class ApiError extends Error {
    code = 'X';
    status = 0;
    retriable = false;
  },
  overrideField: jest.fn(),
  confirmIngestion: jest.fn(),
}));

jest.mock('../services/authStorage', () => ({
  captureActiveSession: jest.fn(async () => ({
    generation: 1,
    scopeKey: 'org-a:actor-a:portal-a:poissonnerie',
    signal: new AbortController().signal,
  })),
  getOperatorContext: jest.fn(async () => ({
    organizationId: 'org-a',
    actorId: 'actor-a',
    businessPortalId: 'portal-a',
    tradeCode: 'poissonnerie',
  })),
  isSessionFenceCurrent: jest.fn(() => true),
  operatorContextKey: jest.fn((context) =>
    [context.organizationId, context.actorId, context.businessPortalId, context.tradeCode].join(':'),
  ),
}));

const mockedOverride = overrideField as jest.MockedFunction<typeof overrideField>;
const mockedConfirm = confirmIngestion as jest.MockedFunction<typeof confirmIngestion>;

async function clearOutbox() {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  await AsyncStorage.multiRemove(['@labelscan:outbox', '@labelscan:outbox:v2']);
}

describe('drainOutbox', () => {
  beforeEach(async () => {
    mockedOverride.mockReset().mockResolvedValue({} as never);
    mockedConfirm.mockReset().mockResolvedValue({
      ingestion_id: 'ing-1',
      status: 'confirmed',
      replayed: false,
    });
    await clearOutbox();
  });

  it('replays pending override + confirm ops with their STABLE idempotency keys', async () => {
    const ov = await enqueueOverrideField(
      { ingestion_id: 'ing-1', field_name: 'FAO_area', value: '27.8.b.1' },
      { idempotencyKey: 'stable-ov-key' },
    );
    await enqueueConfirmIngestion({ ingestion_id: 'ing-1' }, { idempotencyKey: 'stable-cf-key' });

    const result = await drainOutbox();
    expect(result).toEqual({ succeeded: 2, failed: 0, skipped: 0 });

    // The SAME key generated at enqueue reaches the API — the server replays, never doubles.
    expect(mockedOverride).toHaveBeenCalledWith(
      'ing-1',
      'FAO_area',
      '27.8.b.1',
      undefined,
      expect.objectContaining({ idempotencyKey: 'stable-ov-key', correlationId: ov.correlationId }),
    );
    expect(mockedConfirm).toHaveBeenCalledWith(
      'ing-1',
      expect.objectContaining({ idempotencyKey: 'stable-cf-key' }),
    );

    const all = await listAll();
    expect(all.every((op) => op.status === 'succeeded')).toBe(true);
  });

  it('a transient failure leaves the op pending for the NEXT drain', async () => {
    await enqueueConfirmIngestion({ ingestion_id: 'ing-2' });
    mockedConfirm.mockRejectedValueOnce(Object.assign(new Error('boom'), { retriable: true }));

    const r1 = await drainOutbox();
    expect(r1.failed).toBe(1);
    const [op] = await listAll();
    expect(op.status).toBe('pending'); // backed off, not dead-lettered
    expect(op.attempt_count).toBe(1);

    // Next drain (past the backoff) succeeds with the SAME key.
    const r2 = await drainOutbox(Date.now() + 60_000);
    expect(r2.succeeded).toBe(1);
  });

  it('a save waits for an already-running drain and its trailing pass', async () => {
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    mockedConfirm.mockImplementationOnce(
      () => new Promise((resolve) => {
        signalFirstStarted();
        releaseFirst = () => resolve({
          ingestion_id: 'ing-1',
          status: 'confirmed',
          replayed: false,
        });
      }),
    );

    await enqueueConfirmIngestion({ ingestion_id: 'ing-1' });
    const activeDrain = drainOutbox();
    // Let the first drain claim its operation before a save queues another one.
    await firstStarted;

    await enqueueConfirmIngestion({ ingestion_id: 'ing-2' });
    let saveDrainFinished = false;
    const saveDrain = drainOutbox().then(() => {
      saveDrainFinished = true;
    });
    await Promise.resolve();
    expect(saveDrainFinished).toBe(false);

    releaseFirst();
    await Promise.all([activeDrain, saveDrain]);

    const all = await listAll();
    expect(all).toHaveLength(2);
    expect(all.every((op) => op.status === 'succeeded')).toBe(true);
    expect(mockedConfirm).toHaveBeenCalledTimes(2);
  });

  it('leaves op types it does not own untouched', async () => {
    await enqueuePollIngestionStatus({ ingestion_id: 'ing-3' });
    const result = await drainOutbox();
    expect(result.skipped).toBe(1);
    const [op] = await listAll();
    expect(op.status).toBe('pending');
  });

  it('purges old succeeded ops after the drain (the queue cannot grow forever)', async () => {
    await enqueueConfirmIngestion({ ingestion_id: 'ing-4' });
    await drainOutbox(); // succeeds now — kept (younger than the 1-day window)
    expect((await listAll())).toHaveLength(1);

    // A drain running "2 days later" removes the terminal op.
    await drainOutbox(Date.now() + 2 * 24 * 60 * 60 * 1_000);
    expect(await listAll()).toHaveLength(0);
  });
});
