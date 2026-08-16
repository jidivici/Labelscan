import {
  backoffDelayMs,
  enqueueFinalizeReview,
  isRetryableError,
  listAll,
  MAX_ATTEMPTS,
  operationMatchesOperatorContext,
  updatePendingFinalizeReview,
} from '../services/outbox';

async function clearOutbox() {
  const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
  await AsyncStorage.removeItem('@labelscan:outbox');
}

beforeEach(async () => {
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
    owner_business_portal_id: 'portal-a',
    owner_trade_code: 'boucherie',
  } as never;

  it('allows the exact server context and blocks another portal', () => {
    expect(
      operationMatchesOperatorContext(owned, {
        businessPortalId: 'portal-a',
        tradeCode: 'boucherie',
      }),
    ).toBe(true);
    expect(
      operationMatchesOperatorContext(owned, {
        businessPortalId: 'portal-b',
        tradeCode: 'boucherie',
      }),
    ).toBe(false);
    expect(operationMatchesOperatorContext(owned, null)).toBe(false);
  });

  it('keeps unowned historical operations replayable', () => {
    expect(operationMatchesOperatorContext({} as never, null)).toBe(true);
  });
});

describe('pending review updates', () => {
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
});
