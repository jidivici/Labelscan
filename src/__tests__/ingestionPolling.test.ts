import { classifyIngestionStatus, pollIngestionUntilReady } from '../services/ingestionPolling';
import { getIngestionStatus } from '../services/api';
import type { IngestionStatusResponse, InterimField } from '../types/api';

jest.mock('../services/api', () => ({
  // instanceof checks in the poller only need A class here, not the real one.
  ApiError: class ApiError extends Error {},
  getIngestionStatus: jest.fn(),
}));

const mockedGet = getIngestionStatus as jest.MockedFunction<typeof getIngestionStatus>;

function statusResponse(
  status: string,
  interim?: InterimField[] | null,
): IngestionStatusResponse {
  return {
    ingestion_id: 'ing-1',
    status: status as IngestionStatusResponse['status'],
    barcode_raw: null,
    client_captured_at: null,
    server_received_at: '2026-07-02T10:00:00Z',
    correlation_id: 'corr',
    trace_id: 'trace',
    extraction_runs: [],
    latest_fields: null,
    interim_fields: interim ?? null,
  };
}

describe('classifyIngestionStatus', () => {
  it('classifies "extracted" as review_ready', () => {
    expect(classifyIngestionStatus('extracted')).toBe('review_ready');
  });

  it('classifies "needs_review" as review_ready', () => {
    expect(classifyIngestionStatus('needs_review')).toBe('review_ready');
  });

  it('classifies "extraction_failed" as failed', () => {
    expect(classifyIngestionStatus('extraction_failed')).toBe('failed');
  });

  it('classifies "raw_stored" as processing', () => {
    expect(classifyIngestionStatus('raw_stored')).toBe('processing');
  });

  it('classifies "ocr_done" (Tier 3 transit) as processing', () => {
    expect(classifyIngestionStatus('ocr_done')).toBe('processing');
  });

  it('classifies every state of the 12-state machine (no legitimate status is "unknown")', () => {
    // Mirror of the server's ingestion/domain/status.py — a replayed scan can land
    // on ANY of these; none may surface as an error to the operator.
    expect(classifyIngestionStatus('ocr_running')).toBe('processing');
    expect(classifyIngestionStatus('extraction_running')).toBe('processing');
    expect(classifyIngestionStatus('confirmed')).toBe('review_ready'); // re-scan of a reviewed label
    expect(classifyIngestionStatus('ocr_skipped_garbage')).toBe('review_ready');
    expect(classifyIngestionStatus('ocr_failed')).toBe('failed');
    expect(classifyIngestionStatus('rejected')).toBe('failed');
    expect(classifyIngestionStatus('halted_missing_context')).toBe('failed');
  });

  it('classifies unknown status as unknown', () => {
    expect(classifyIngestionStatus('some_new_status')).toBe('unknown');
  });

  it('classifies empty string as unknown', () => {
    expect(classifyIngestionStatus('')).toBe('unknown');
  });
});

describe('pollIngestionUntilReady — wave 2 (onInterim)', () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  const interim: InterimField[] = [
    {
      field_name: 'expiry_date',
      value: '2026-06-20',
      source: 'deterministic',
      created_at: '2026-07-02T10:00:01Z',
    },
  ];

  it('fires onInterim ONCE for a repeated ocr_done payload, then resolves review_ready', async () => {
    mockedGet
      .mockResolvedValueOnce(statusResponse('raw_stored'))
      .mockResolvedValueOnce(statusResponse('ocr_done', interim))
      .mockResolvedValueOnce(statusResponse('ocr_done', interim))
      .mockResolvedValueOnce(statusResponse('extracted'));

    const onInterim = jest.fn();
    const result = await pollIngestionUntilReady('ing-1', { onInterim, baseDelayMs: 1 });

    expect(result.kind).toBe('review_ready');
    expect(onInterim).toHaveBeenCalledTimes(1);
    expect(onInterim.mock.calls[0][0].interim_fields).toEqual(interim);
  });

  it('fires onInterim on ocr_done even with no interim fields (real banner signal)', async () => {
    mockedGet
      .mockResolvedValueOnce(statusResponse('ocr_done', []))
      .mockResolvedValueOnce(statusResponse('extracted'));

    const onInterim = jest.fn();
    const result = await pollIngestionUntilReady('ing-1', { onInterim, baseDelayMs: 1 });

    expect(result.kind).toBe('review_ready');
    expect(onInterim).toHaveBeenCalledTimes(1);
  });

  it('keeps polling through ocr_done without onInterim (backward compatible)', async () => {
    mockedGet
      .mockResolvedValueOnce(statusResponse('ocr_done', interim))
      .mockResolvedValueOnce(statusResponse('extracted'));

    const result = await pollIngestionUntilReady('ing-1', { baseDelayMs: 1 });
    expect(result.kind).toBe('review_ready');
  });
});

describe('pollIngestionUntilReady — long-poll (Tier 4)', () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it('first GET is immediate, then long-polls with the last observed status', async () => {
    mockedGet
      .mockResolvedValueOnce(statusResponse('raw_stored'))
      .mockResolvedValueOnce(statusResponse('extracted'));

    const result = await pollIngestionUntilReady('ing-1', { baseDelayMs: 1 });
    expect(result.kind).toBe('review_ready');
    expect(mockedGet).toHaveBeenCalledTimes(2);

    // Call 1: baseline probe — no hold params.
    const first = mockedGet.mock.calls[0][1]!;
    expect(first.waitSeconds).toBeUndefined();
    expect(first.lastStatus).toBeUndefined();

    // Call 2: server-side hold armed against the observed baseline, with an HTTP
    // timeout sized ABOVE the hold (hold expiry must never look like a timeout).
    const second = mockedGet.mock.calls[1][1]!;
    expect(second.waitSeconds).toBe(25);
    expect(second.lastStatus).toBe('raw_stored');
    expect(second.timeoutMs).toBe(25 * 1000 + 10_000);
  });

  it('falls back to paced polling when the server ignores the hold (anti-spin)', async () => {
    // An old server: always answers instantly with the SAME status.
    mockedGet.mockResolvedValue(statusResponse('raw_stored'));

    const result = await pollIngestionUntilReady('ing-1', { baseDelayMs: 1, maxAttempts: 4 });
    expect(result.kind).toBe('timeout');
    expect(mockedGet).toHaveBeenCalledTimes(4);

    // Exactly ONE hold was attempted (call 2); after the instant unchanged reply the
    // loop stopped trusting the hold — calls 3 and 4 are classic paced GETs.
    const holds = mockedGet.mock.calls.filter(([, opts]) => opts?.waitSeconds != null);
    expect(holds).toHaveLength(1);
    expect(mockedGet.mock.calls[2][1]!.waitSeconds).toBeUndefined();
    expect(mockedGet.mock.calls[3][1]!.waitSeconds).toBeUndefined();
  });

  it('longPollSeconds: 0 disables the hold entirely (classic cadence)', async () => {
    mockedGet
      .mockResolvedValueOnce(statusResponse('raw_stored'))
      .mockResolvedValueOnce(statusResponse('extracted'));

    const result = await pollIngestionUntilReady('ing-1', { baseDelayMs: 1, longPollSeconds: 0 });
    expect(result.kind).toBe('review_ready');
    for (const [, opts] of mockedGet.mock.calls) {
      expect(opts?.waitSeconds).toBeUndefined();
      expect(opts?.lastStatus).toBeUndefined();
    }
  });
});
