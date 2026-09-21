jest.mock('../services/auth', () => ({
  restoreAuthentication: jest.fn(),
  isAuthenticationRestoreRetryable: jest.fn(),
}));

import {
  isAuthenticationRestoreRetryable,
  restoreAuthentication,
  type OperatorSession,
} from '../services/auth';
import { startSessionRestore } from '../services/sessionRestore';

const restoreMock = jest.mocked(restoreAuthentication);
const retryableMock = jest.mocked(isAuthenticationRestoreRetryable);
const networkError = new Error('network unavailable');
const session: OperatorSession = {
  username: 'manager',
  organizationId: 'org-labelscan',
  actorId: 'actor-manager',
  businessPortalId: 'portal-poissonnerie',
  tradeCode: 'poissonnerie',
};

function callbacks() {
  return {
    onRestored: jest.fn(),
    onWaiting: jest.fn(),
    onError: jest.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('cold-start session restoration retries', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetAllMocks();
    retryableMock.mockImplementation((error) => error === networkError);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('waits after a network failure and restores automatically when the next request succeeds', async () => {
    restoreMock.mockRejectedValueOnce(networkError).mockResolvedValueOnce(session);
    const handlers = callbacks();
    startSessionRestore(handlers);

    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(restoreMock.mock.calls[0][0]?.signal).toBeInstanceOf(AbortSignal);
    await jest.advanceTimersByTimeAsync(0);
    expect(handlers.onWaiting).toHaveBeenCalledTimes(1);
    expect(handlers.onRestored).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_999);
    expect(restoreMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(handlers.onRestored).toHaveBeenCalledWith(session);
    expect(restoreMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });

  it('never starts another attempt while a request is still pending', async () => {
    const pending = deferred<OperatorSession | null>();
    restoreMock.mockRejectedValueOnce(networkError).mockReturnValueOnce(pending.promise);
    const handlers = callbacks();
    const restore = startSessionRestore(handlers);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(restoreMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(restoreMock).toHaveBeenCalledTimes(2);

    pending.resolve(session);
    await jest.advanceTimersByTimeAsync(0);
    expect(handlers.onRestored).toHaveBeenCalledWith(session);
    restore.cancel();
  });

  it('backs off through 2, 5 and 10 seconds, then caps every later delay at 30 seconds', async () => {
    restoreMock.mockRejectedValue(networkError);
    const handlers = callbacks();
    const restore = startSessionRestore(handlers);
    await jest.advanceTimersByTimeAsync(0);

    let expectedCalls = 1;
    for (const delay of [2_000, 5_000, 10_000, 30_000, 30_000, 30_000]) {
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(restoreMock).toHaveBeenCalledTimes(expectedCalls);
      await jest.advanceTimersByTimeAsync(1);
      expectedCalls += 1;
      expect(restoreMock).toHaveBeenCalledTimes(expectedCalls);
    }
    expect(handlers.onWaiting).toHaveBeenCalledTimes(expectedCalls);
    expect(handlers.onRestored).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    restore.cancel();
  });

  it('cancels a scheduled retry and aborts the request signal', async () => {
    restoreMock.mockRejectedValue(networkError);
    const handlers = callbacks();
    const restore = startSessionRestore(handlers);
    await jest.advanceTimersByTimeAsync(0);
    const signal = restoreMock.mock.calls[0][0]?.signal;

    restore.cancel();
    expect(signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(handlers.onRestored).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)('ignores a late %s after cancellation', async (result) => {
    const pending = deferred<OperatorSession | null>();
    restoreMock.mockReturnValue(pending.promise);
    const handlers = callbacks();
    const restore = startSessionRestore(handlers);
    restore.cancel();

    if (result === 'success') pending.resolve(session);
    else pending.reject(networkError);
    await jest.advanceTimersByTimeAsync(120_000);

    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(handlers.onRestored).not.toHaveBeenCalled();
    expect(handlers.onWaiting).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(retryableMock).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports a permanent rejection once without retrying', async () => {
    const error = new Error('secure storage failed');
    restoreMock.mockRejectedValue(error);
    const handlers = callbacks();
    startSessionRestore(handlers);
    await jest.advanceTimersByTimeAsync(120_000);

    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(handlers.onError).toHaveBeenCalledWith(error);
    expect(handlers.onRestored).not.toHaveBeenCalled();
    expect(handlers.onWaiting).not.toHaveBeenCalled();
    expect(restoreMock).toHaveBeenCalledTimes(1);
  });

  it('treats a null session as a terminal signed-out result', async () => {
    restoreMock.mockResolvedValue(null);
    const handlers = callbacks();
    startSessionRestore(handlers);
    await jest.advanceTimersByTimeAsync(120_000);

    expect(handlers.onRestored).toHaveBeenCalledTimes(1);
    expect(handlers.onRestored).toHaveBeenCalledWith(null);
    expect(handlers.onWaiting).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(restoreMock).toHaveBeenCalledTimes(1);
  });
});
