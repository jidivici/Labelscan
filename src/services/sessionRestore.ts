import {
  isAuthenticationRestoreRetryable,
  restoreAuthentication,
  type OperatorSession,
} from './auth';

const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const;

interface SessionRestoreCallbacks {
  onRestored: (session: OperatorSession | null) => void;
  onWaiting: () => void;
  onError: (error: unknown) => void;
}

/** Retry cold-start validation while the network returns, without opening the auth gate. */
export function startSessionRestore(callbacks: SessionRestoreCallbacks): { cancel: () => void } {
  const controller = new AbortController();
  let cancelled = false;
  let finished = false;
  let retryIndex = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopped = () => cancelled || finished;

  async function attempt(): Promise<void> {
    if (stopped()) return;
    let outcome:
      | { ok: true; session: OperatorSession | null }
      | { ok: false; error: unknown };
    try {
      outcome = {
        ok: true,
        session: await restoreAuthentication({ signal: controller.signal }),
      };
    } catch (error) {
      outcome = { ok: false, error };
    }

    if (stopped()) return;
    // Only the authentication request belongs to the try/catch above. A callback
    // failure must never be interpreted as a network failure and retried.
    if (outcome.ok) {
      finished = true;
      callbacks.onRestored(outcome.session);
      return;
    }
    if (!isAuthenticationRestoreRetryable(outcome.error)) {
      finished = true;
      callbacks.onError(outcome.error);
      return;
    }

    callbacks.onWaiting();
    if (stopped()) return;
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    retryIndex += 1;
    // Schedule only after this request has settled; a slow request cannot overlap
    // the next attempt, even after the backoff reaches its 30-second cap.
    timer = setTimeout(() => {
      timer = undefined;
      void attempt();
    }, delay);
  }

  void attempt();

  return {
    cancel() {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      controller.abort();
    },
  };
}
