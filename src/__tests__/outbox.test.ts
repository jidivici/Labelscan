import { backoffDelayMs, isRetryableError, MAX_ATTEMPTS } from '../services/outbox';

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
