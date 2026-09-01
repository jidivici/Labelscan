/**
 * Scan queue (workflow v1) — the store that owns every in-flight scan's lifecycle
 * across screens. Mocks its three collaborators (ingestionSubmit, ingestionResult,
 * storage's photo helpers) so these tests exercise ONLY the queue's own state
 * machine, scheduler and reconciliation — not the network/poll internals already
 * covered by ingestionPolling.test.ts / ingestionResult.test.ts.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

jest.mock('../services/storage', () => ({
  clearPendingScanPhotos: jest.fn(async () => undefined),
  persistPendingPhoto: jest.fn(async (id: string) => `file:///pending/${id}.jpg`),
  deletePendingPhoto: jest.fn(async () => undefined),
  deletePendingPhotoStrict: jest.fn(async () => undefined),
  isCanonicalPendingPhotoUri: jest.fn((uri: unknown) =>
    typeof uri === 'string' && /^file:\/\/\/pending\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.jpg$/.test(uri)),
  sweepPendingPhotos: jest.fn(async () => undefined),
}));

jest.mock('../services/ingestionSubmit', () => ({
  enqueueCapture: jest.fn(),
  executeCreateIngestionOp: jest.fn(),
}));

jest.mock('../services/ingestionResult', () => ({
  waitForIngestionResult: jest.fn(),
}));

jest.mock('../services/outbox', () => ({
  getOperation: jest.fn(),
}));

jest.mock('../services/authStorage', () => ({
  captureActiveSession: jest.fn(),
  getOperatorContext: jest.fn(),
  isSessionFenceCurrent: jest.fn(() => true),
  operatorContextKey: jest.fn((context: {
    organizationId: string;
    actorId: string;
    businessPortalId: string;
    tradeCode: string;
  }) => [context.organizationId, context.actorId, context.businessPortalId, context.tradeCode].join(':')),
}));

import {
  clearPendingScanPhotos,
  deletePendingPhoto,
  persistPendingPhoto,
} from '../services/storage';
import { enqueueCapture, executeCreateIngestionOp } from '../services/ingestionSubmit';
import { waitForIngestionResult } from '../services/ingestionResult';
import { getOperation } from '../services/outbox';
import { captureActiveSession, getOperatorContext } from '../services/authStorage';
import {
  _resetScanQueueForTests,
  clearScanQueue,
  completeScan,
  discardScan,
  enqueueScan,
  getSnapshot,
  initScanQueue,
  reconcileScanQueue,
  retryScan,
  saveScanEdits,
  subscribe,
} from '../services/scanQueue';

const mockedEnqueueCapture = enqueueCapture as jest.MockedFunction<typeof enqueueCapture>;
const mockedExecute = executeCreateIngestionOp as jest.MockedFunction<typeof executeCreateIngestionOp>;
const mockedWait = waitForIngestionResult as jest.MockedFunction<typeof waitForIngestionResult>;
const mockedGetOp = getOperation as jest.MockedFunction<typeof getOperation>;
const mockedPersistPhoto = persistPendingPhoto as jest.MockedFunction<typeof persistPendingPhoto>;
const mockedDeletePhoto = deletePendingPhoto as jest.MockedFunction<typeof deletePendingPhoto>;
const mockedClearPendingPhotos = clearPendingScanPhotos as jest.MockedFunction<
  typeof clearPendingScanPhotos
>;
const mockedContext = getOperatorContext as jest.MockedFunction<typeof getOperatorContext>;
const mockedFence = captureActiveSession as jest.MockedFunction<typeof captureActiveSession>;

interface FakeOp {
  schema_version: 2;
  owner_organization_id: string;
  owner_actor_id: string;
  owner_business_portal_id: string;
  owner_trade_code: string;
  id: string;
  idempotencyKey: string;
  correlationId: string;
  status: 'pending' | 'in_flight' | 'succeeded' | 'dead_letter';
  attempt_count: number;
  next_attempt_at: string;
  last_error_code: string | null;
  last_error_message: string | null;
  result: { ingestion_id: string; status: string; replayed: boolean } | null;
  created_at: string;
  updated_at: string;
  type: 'create_ingestion';
  payload: { file: { uri: string; name: string; type: string } };
}

let opSeq = 0;
function fakeOp(overrides: Partial<FakeOp> = {}): FakeOp {
  opSeq += 1;
  return {
    schema_version: 2,
    owner_organization_id: 'org-a',
    owner_actor_id: 'actor-a',
    owner_business_portal_id: 'portal-a',
    owner_trade_code: 'poissonnerie',
    id: `op-${opSeq}`,
    idempotencyKey: `k-${opSeq}`,
    correlationId: `c-${opSeq}`,
    status: 'pending',
    attempt_count: 0,
    next_attempt_at: new Date().toISOString(),
    last_error_code: null,
    last_error_message: null,
    result: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    type: 'create_ingestion',
    payload: { file: { uri: 'x', name: 'label.jpg', type: 'image/jpeg' } },
    ...overrides,
  };
}

// Deferred submit: enqueueScan resolves once the entry exists, then fires the submit
// in a microtask — flush with a couple of awaited ticks before asserting outcomes.
async function flush(times = 3) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('scanQueue', () => {
  beforeEach(async () => {
    _resetScanQueueForTests();
    await AsyncStorage.clear();
    opSeq = 0;
    mockedEnqueueCapture.mockReset();
    mockedExecute.mockReset();
    mockedWait.mockReset();
    mockedGetOp.mockReset();
    mockedPersistPhoto.mockReset().mockImplementation(async (id: string) => `file:///pending/${id}.jpg`);
    mockedDeletePhoto.mockReset().mockResolvedValue(undefined);
    mockedClearPendingPhotos.mockReset().mockResolvedValue(undefined);
    mockedContext.mockReset().mockResolvedValue({
      organizationId: 'org-a',
      actorId: 'actor-a',
      businessPortalId: 'portal-a',
      tradeCode: 'poissonnerie',
    });
    mockedFence.mockReset().mockImplementation(async () => ({
      generation: 1,
      scopeKey: 'org-a:actor-a:portal-a:poissonnerie',
      signal: new AbortController().signal,
    }));
    // Default: a poll that never resolves (tests opt into a real outcome via
    // mockResolvedValueOnce/mockImplementation). Without this, any scan that reaches
    // 'extracting' without an explicit stub would await `undefined` and throw.
    mockedWait.mockReturnValue(new Promise(() => {}));
  });

  it('enqueueScan adds a submitting entry immediately, before the network resolves', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    let resolveExecute: (v: Awaited<ReturnType<typeof executeCreateIngestionOp>>) => void = () => {};
    mockedExecute.mockReturnValue(new Promise((r) => (resolveExecute = r)));

    const scan = await enqueueScan({ tempUri: 'file:///cache/x.jpg', capturedAt: '2026-07-05T10:00:00Z' });

    expect(scan.status).toBe('submitting');
    expect(getSnapshot().scans).toHaveLength(1);

    resolveExecute({ kind: 'succeeded', ingestionId: 'ing-1', replayed: false });
    await flush();
  });

  it('does not enqueue an operation when the durable photo copy fails', async () => {
    mockedPersistPhoto.mockResolvedValueOnce(null);

    await expect(enqueueScan({
      tempUri: 'file:///cache/unsafe.jpg',
      capturedAt: '2026-07-05T10:00:00Z',
    })).rejects.toThrow('DURABLE_PHOTO_PERSIST_FAILED');

    expect(mockedEnqueueCapture).not.toHaveBeenCalled();
    expect(getSnapshot().scans).toHaveLength(0);
  });

  it('strictly purges the pending-photo directory at a session boundary', async () => {
    await clearScanQueue();

    expect(mockedClearPendingPhotos).toHaveBeenCalledTimes(1);
  });

  it('does not let an old submit continuation mutate a same-id scan in a new session', async () => {
    mockedEnqueueCapture.mockResolvedValueOnce(fakeOp());
    let resolveOld!: (value: Awaited<ReturnType<typeof executeCreateIngestionOp>>) => void;
    mockedExecute.mockReturnValueOnce(new Promise((resolve) => {
      resolveOld = resolve;
    }));

    await enqueueScan({
      id: 'shared-id',
      tempUri: 'file:///cache/old.jpg',
      capturedAt: '2026-08-31T08:00:00Z',
    });
    await clearScanQueue();

    mockedContext.mockResolvedValue({
      organizationId: 'org-b',
      actorId: 'actor-b',
      businessPortalId: 'portal-b',
      tradeCode: 'boucherie',
    });
    mockedFence.mockResolvedValue({
      generation: 2,
      scopeKey: 'org-b:actor-b:portal-b:boucherie',
      signal: new AbortController().signal,
    });
    mockedEnqueueCapture.mockResolvedValueOnce(fakeOp({
      id: 'op-new',
      owner_organization_id: 'org-b',
      owner_actor_id: 'actor-b',
      owner_business_portal_id: 'portal-b',
      owner_trade_code: 'boucherie',
    }));
    mockedExecute.mockReturnValueOnce(new Promise(() => {}));
    await enqueueScan({
      id: 'shared-id',
      tempUri: 'file:///cache/new.jpg',
      capturedAt: '2026-08-31T08:01:00Z',
    });

    resolveOld({ kind: 'succeeded', ingestionId: 'ingestion-old', replayed: false });
    await flush(5);

    expect(getSnapshot().scans).toHaveLength(1);
    expect(getSnapshot().scans[0]).toMatchObject({
      id: 'shared-id',
      organizationId: 'org-b',
      status: 'submitting',
      ingestionId: null,
    });
  });

  it('enqueueScan honors a pre-generated id (camera durable-raw-copy handoff)', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockReturnValue(new Promise(() => {}));

    const scan = await enqueueScan({
      id: 'fixed-id-123',
      tempUri: 'file:///pending/fixed-id-123-raw.jpg',
      capturedAt: '2026-07-05T10:00:00Z',
    });

    expect(scan.id).toBe('fixed-id-123');
    expect(mockedPersistPhoto).toHaveBeenCalledWith('fixed-id-123', 'file:///pending/fixed-id-123-raw.jpg');
  });

  it('stores the received trade locally without adding it to the ingestion payload', async () => {
    mockedContext.mockResolvedValue({
      organizationId: 'org-b',
      actorId: 'actor-b',
      businessPortalId: 'portal-boucherie',
      tradeCode: 'boucherie',
    });
    mockedFence.mockResolvedValue({
      generation: 1,
      scopeKey: 'org-b:actor-b:portal-boucherie:boucherie',
      signal: new AbortController().signal,
    });
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockReturnValue(new Promise(() => {}));

    const scan = await enqueueScan({
      tempUri: 'file:///cache/boucherie.jpg',
      capturedAt: '2026-08-04T08:00:00Z',
    });

    expect(scan.tradeCode).toBe('boucherie');
    expect(scan.businessPortalId).toBe('portal-boucherie');
    expect(mockedEnqueueCapture).toHaveBeenCalledWith({
      fileUri: scan.photoUri,
      barcodeRaw: undefined,
      capturedAt: '2026-08-04T08:00:00Z',
    });
    expect(mockedEnqueueCapture.mock.calls[0][0]).not.toHaveProperty('tradeCode');
    expect(mockedEnqueueCapture.mock.calls[0][0]).not.toHaveProperty('businessPortalId');
  });

  it('saveScanEdits persists the review draft and it survives a restart (workflow v2 session)', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockReturnValue(new Promise(() => {})); // stays 'submitting'

    const scan = await enqueueScan({
      id: 'scan-e',
      tempUri: 'file:///cache/x.jpg',
      capturedAt: '2026-07-05T10:00:00Z',
    });

    saveScanEdits(scan.id, { weight: '5 kg', allergens: 'Poisson' });
    expect(getSnapshot().scans[0].edits).toEqual({ weight: '5 kg', allergens: 'Poisson' });

    await flush();
    const raw = await AsyncStorage.getItem('@labelscan:scanQueue:v2');
    expect(JSON.parse(raw as string)[0].edits).toEqual({ weight: '5 kg', allergens: 'Poisson' });

    // Restart: reset the singleton and re-hydrate from storage → the draft is restored.
    _resetScanQueueForTests();
    await initScanQueue();
    expect(getSnapshot().scans[0].edits).toEqual({ weight: '5 kg', allergens: 'Poisson' });
  });

  it('saveScanEdits is a no-op for an unknown scan id', () => {
    saveScanEdits('does-not-exist', { weight: '1 kg' });
    expect(getSnapshot().scans).toHaveLength(0);
  });

  it('submit succeeded → status becomes extracting and a poll starts', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockResolvedValue({ kind: 'succeeded', ingestionId: 'ing-1', replayed: false });
    mockedWait.mockReturnValue(new Promise(() => {})); // never resolves — just prove it was called

    await enqueueScan({ tempUri: 'file:///cache/x.jpg', capturedAt: '2026-07-05T10:00:00Z' });
    await flush();

    const [scan] = getSnapshot().scans;
    expect(scan.status).toBe('extracting');
    expect(scan.ingestionId).toBe('ing-1');
    expect(mockedWait).toHaveBeenCalledWith('ing-1', expect.anything());
  });

  it('releases its controller slot before re-arming after a bounded poll timeout', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockResolvedValue({ kind: 'succeeded', ingestionId: 'ing-timeout', replayed: false });
    mockedWait
      .mockResolvedValueOnce({ kind: 'timeout' })
      .mockReturnValueOnce(new Promise(() => {}));

    await enqueueScan({ tempUri: 'file:///cache/timeout.jpg', capturedAt: '2026-07-05T10:00:00Z' });
    await flush(12);

    expect(mockedWait).toHaveBeenCalledTimes(2);
    expect(getSnapshot().scans[0].status).toBe('extracting');
  });

  it('submit dead_letter → submit_error, retryable via retryScan', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockResolvedValueOnce({ kind: 'dead_letter', code: 'NETWORK_ERROR', message: 'x' });

    const scan = await enqueueScan({ tempUri: 'file:///cache/x.jpg', capturedAt: '2026-07-05T10:00:00Z' });
    await flush();
    expect(getSnapshot().scans[0].status).toBe('submit_error');

    mockedEnqueueCapture.mockResolvedValueOnce(fakeOp());
    mockedExecute.mockResolvedValueOnce({ kind: 'succeeded', ingestionId: 'ing-2', replayed: false });
    mockedWait.mockReturnValue(new Promise(() => {}));

    await retryScan(scan.id);
    await flush();

    expect(getSnapshot().scans[0].status).toBe('extracting');
    expect(getSnapshot().scans[0].ingestionId).toBe('ing-2');
  });

  it('poll ready without a loadable run becomes retryable and stays non-confirmable', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockResolvedValue({ kind: 'succeeded', ingestionId: 'ing-1', replayed: false });
    mockedWait.mockResolvedValue({
      kind: 'ready',
      ingestion: { ingestion_id: 'ing-1' } as never,
      run: null,
    });

    const scan = await enqueueScan({ tempUri: 'file:///cache/x.jpg', capturedAt: '2026-07-05T10:00:00Z' });
    await flush(6);

    const snap = getSnapshot();
    expect(snap.scans[0].status).toBe('extract_error');
    expect(snap.scans[0].errorCode).toBe('FIELDS_UNAVAILABLE');
    expect(snap.results[scan.id]).toBeDefined();
    expect(snap.interim[scan.id]).toBeUndefined();
  });

  it('an empty final extraction requires a fresh photo and cannot enter ready review', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockResolvedValue({ kind: 'succeeded', ingestionId: 'ing-empty', replayed: false });
    mockedWait.mockResolvedValue({
      kind: 'ready',
      ingestion: { ingestion_id: 'ing-empty' } as never,
      run: { fields: [] } as never,
    });

    await enqueueScan({ tempUri: 'file:///cache/empty.jpg', capturedAt: '2026-08-20T10:00:00Z' });
    await flush(6);

    expect(getSnapshot().scans[0].status).toBe('recapture_required');
    expect(getSnapshot().results).toBeDefined();
  });

  it('persists the recapture decision and restores it safely after an offline restart', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockResolvedValue({ kind: 'succeeded', ingestionId: 'ing-offline-bad', replayed: false });
    mockedWait.mockResolvedValue({
      kind: 'ready',
      ingestion: { ingestion_id: 'ing-offline-bad' } as never,
      run: { fields: [] } as never,
    });

    await enqueueScan({ tempUri: 'file:///cache/offline-bad.jpg', capturedAt: '2026-08-20T10:00:00Z' });
    await flush(8);
    expect(getSnapshot().scans[0].status).toBe('recapture_required');
    expect(JSON.parse((await AsyncStorage.getItem('@labelscan:scanQueue:v2')) as string)[0].status)
      .toBe('recapture_required');

    _resetScanQueueForTests();
    mockedWait.mockResolvedValue({
      kind: 'ready',
      ingestion: { ingestion_id: 'ing-offline-bad' } as never,
      run: { fields: [] } as never,
    });
    await initScanQueue();
    await flush(6);

    expect(getSnapshot().scans[0].status).toBe('recapture_required');
  });

  it('a terminal extraction failure requires a new photo instead of re-polling', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockResolvedValue({ kind: 'succeeded', ingestionId: 'ing-1', replayed: false });
    mockedWait.mockResolvedValueOnce({ kind: 'failed', status: 'extraction_failed' });

    const scan = await enqueueScan({ tempUri: 'file:///cache/x.jpg', capturedAt: '2026-07-05T10:00:00Z' });
    await flush(6);
    expect(getSnapshot().scans[0].status).toBe('recapture_required');

    const pollCalls = mockedWait.mock.calls.length;
    await retryScan(scan.id);
    await flush();
    expect(getSnapshot().scans[0].status).toBe('recapture_required');
    expect(mockedWait).toHaveBeenCalledTimes(pollCalls);
  });

  it('caps concurrent polls at 3 and drains the FIFO wait list as slots free up', async () => {
    mockedEnqueueCapture.mockImplementation(async () => fakeOp());
    mockedExecute.mockImplementation(async () => ({
      kind: 'succeeded',
      ingestionId: `ing-${Math.random()}`,
      replayed: false,
    }));
    const resolvers: Array<(v: Awaited<ReturnType<typeof waitForIngestionResult>>) => void> = [];
    mockedWait.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    for (let i = 0; i < 4; i++) {
      await enqueueScan({ tempUri: `file:///cache/${i}.jpg`, capturedAt: '2026-07-05T10:00:00Z' });
    }
    await flush(6);

    // Only 3 concurrent polls may be in flight — the 4th scan waits in FIFO.
    expect(mockedWait).toHaveBeenCalledTimes(3);
    expect(getSnapshot().scans.filter((s) => s.status === 'extracting')).toHaveLength(4);

    // Resolve one — the waiting scan's poll should start.
    resolvers[0]({ kind: 'ready', ingestion: { ingestion_id: 'x' } as never, run: null });
    await flush(6);
    expect(mockedWait).toHaveBeenCalledTimes(4);
  });

  it('replayed submit onto an already-active ingestion silently drops the duplicate entry', async () => {
    mockedEnqueueCapture.mockResolvedValueOnce(fakeOp());
    mockedExecute.mockResolvedValueOnce({ kind: 'succeeded', ingestionId: 'ing-shared', replayed: false });
    mockedWait.mockReturnValue(new Promise(() => {}));

    const first = await enqueueScan({ tempUri: 'file:///cache/a.jpg', capturedAt: '2026-07-05T10:00:00Z' });
    await flush();
    expect(getSnapshot().scans).toHaveLength(1);

    mockedEnqueueCapture.mockResolvedValueOnce(fakeOp());
    mockedExecute.mockResolvedValueOnce({ kind: 'succeeded', ingestionId: 'ing-shared', replayed: true });
    const second = await enqueueScan({ tempUri: 'file:///cache/b.jpg', capturedAt: '2026-07-05T10:00:01Z' });
    await flush();

    // The duplicate (second) entry was removed; the first survives untouched.
    expect(getSnapshot().scans).toHaveLength(1);
    expect(getSnapshot().scans[0].id).toBe(first.id);
    expect(mockedDeletePhoto).toHaveBeenCalledWith(second.photoUri);
    expect(mockedDeletePhoto).not.toHaveBeenCalledWith(first.photoUri);
  });

  it('discardScan removes the entry, deletes its photo, and aborts its poll', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockResolvedValue({ kind: 'succeeded', ingestionId: 'ing-1', replayed: false });
    mockedWait.mockReturnValue(new Promise(() => {}));

    const scan = await enqueueScan({ tempUri: 'file:///cache/x.jpg', capturedAt: '2026-07-05T10:00:00Z' });
    await flush();
    expect(getSnapshot().scans).toHaveLength(1);

    await discardScan(scan.id);

    expect(getSnapshot().scans).toHaveLength(0);
    expect(mockedDeletePhoto).toHaveBeenCalledWith(scan.photoUri);
  });

  it('completeScan removes the entry and its result/interim state', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockResolvedValue({ kind: 'succeeded', ingestionId: 'ing-1', replayed: false });
    mockedWait.mockResolvedValue({ kind: 'ready', ingestion: { ingestion_id: 'ing-1' } as never, run: null });

    const scan = await enqueueScan({ tempUri: 'file:///cache/x.jpg', capturedAt: '2026-07-05T10:00:00Z' });
    await flush(6);
    expect(getSnapshot().results[scan.id]).toBeDefined();

    await completeScan(scan.id);

    expect(getSnapshot().scans).toHaveLength(0);
    expect(getSnapshot().results[scan.id]).toBeUndefined();
  });

  it('hydration restores persisted scans, sweeps orphan photos, and reconciles', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockReturnValue(new Promise(() => {})); // stay 'submitting'
    await enqueueScan({ tempUri: 'file:///cache/x.jpg', capturedAt: '2026-07-05T10:00:00Z' });
    await flush();

    // Simulate an app restart: fresh module state, but AsyncStorage retains the queue.
    _resetScanQueueForTests();
    mockedGetOp.mockResolvedValue(fakeOp({ status: 'succeeded', result: { ingestion_id: 'ing-restored', status: 'raw_stored', replayed: false } }));
    mockedWait.mockReturnValue(new Promise(() => {}));

    await initScanQueue();

    const snap = getSnapshot();
    expect(snap.scans).toHaveLength(1);
    expect(snap.scans[0].status).toBe('extracting');
    expect(snap.scans[0].ingestionId).toBe('ing-restored');
  });

  it('reconcileScanQueue moves a submitting scan to submit_error when its op is dead_letter', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockReturnValue(new Promise(() => {})); // stuck submitting
    const scan = await enqueueScan({ tempUri: 'file:///cache/x.jpg', capturedAt: '2026-07-05T10:00:00Z' });
    await flush();
    expect(getSnapshot().scans[0].status).toBe('submitting');

    mockedGetOp.mockResolvedValue(fakeOp({ status: 'dead_letter', last_error_code: 'NETWORK_ERROR' }));
    await reconcileScanQueue();

    const updated = getSnapshot().scans.find((s) => s.id === scan.id);
    expect(updated?.status).toBe('submit_error');
    expect(updated?.errorCode).toBe('NETWORK_ERROR');
  });

  it('reconcileScanQueue marks submit_error when the op is missing (purged/lost)', async () => {
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockReturnValue(new Promise(() => {}));
    await enqueueScan({ tempUri: 'file:///cache/x.jpg', capturedAt: '2026-07-05T10:00:00Z' });
    await flush();

    mockedGetOp.mockResolvedValue(null);
    await reconcileScanQueue();

    expect(getSnapshot().scans[0].status).toBe('submit_error');
    expect(getSnapshot().scans[0].errorCode).toBe('OP_MISSING');
  });

  it('notifies subscribers on every state transition', async () => {
    const cb = jest.fn();
    const unsubscribe = subscribe(cb);
    mockedEnqueueCapture.mockResolvedValue(fakeOp());
    mockedExecute.mockResolvedValue({ kind: 'succeeded', ingestionId: 'ing-1', replayed: false });
    mockedWait.mockReturnValue(new Promise(() => {}));

    await enqueueScan({ tempUri: 'file:///cache/x.jpg', capturedAt: '2026-07-05T10:00:00Z' });
    await flush();

    expect(cb).toHaveBeenCalled();
    unsubscribe();
  });
});
