/**
 * Secure storage for the JWT access token (expo-secure-store → Keychain / Keystore).
 *
 * The token never touches AsyncStorage (plaintext). A small in-memory cache avoids
 * a Keychain read on every request; it is the single source of truth during a
 * session and is kept in sync by set/clear.
 *
 * It also exposes a tiny "unauthenticated" event so the low-level API client can
 * signal an expired/invalid session WITHOUT importing React — the auth UI
 * subscribes and routes back to the login screen.
 */

import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'labelscan.access_token';
const REFRESH_TOKEN_KEY = 'labelscan.refresh_token';
const OPERATOR_CONTEXT_KEY = 'labelscan.operator_context';
// The username is NOT a secret, but it shares the token's lifecycle (set on login,
// cleared on logout) so we keep it in the same store to avoid a second mechanism.
const USERNAME_KEY = 'labelscan.username';

// undefined = not yet loaded from the keystore; null = loaded, no token.
let cachedToken: string | null | undefined;
let cachedRefreshToken: string | null | undefined;
let cachedUsername: string | null | undefined;
let cachedOperatorContext: OperatorContext | null | undefined;
const tokenListeners = new Set<(token: string | null) => void>();
let credentialWriteQueue: Promise<unknown> = Promise.resolve();
let credentialEpoch = 0;

function serializeCredentialWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = credentialWriteQueue.then(task, task);
  credentialWriteQueue = run;
  return run;
}

/** Server-authoritative assignment attached to every mobile operator session. */
export interface OperatorContext {
  organizationId: string;
  actorId: string;
  businessPortalId: string;
  tradeCode: string;
}

/** Immutable capability captured by work that belongs to one authenticated scope. */
export interface SessionFence {
  readonly generation: number;
  readonly scopeKey: string;
  readonly signal: AbortSignal;
}

let sessionGeneration = 0;
let activeScopeKey: string | null = null;
let sessionController = new AbortController();
sessionController.abort();

export function operatorContextKey(context: OperatorContext): string {
  return [
    context.organizationId,
    context.actorId,
    context.businessPortalId,
    context.tradeCode,
  ].join(':');
}

function rotateSessionFence(nextScopeKey: string | null): void {
  sessionController.abort();
  sessionGeneration += 1;
  activeScopeKey = nextScopeKey;
  sessionController = new AbortController();
  if (nextScopeKey == null) sessionController.abort();
}

/** Abort local work immediately while logout/revocation persistence is still running. */
export function invalidateActiveSessionWork(): void {
  rotateSessionFence(null);
}

/** Capture the current scope and its abort signal before starting asynchronous work. */
export async function captureActiveSession(): Promise<SessionFence | null> {
  // Snapshot synchronously before the SecureStore/cache await. Otherwise work invoked
  // by session A could resume after a fast logout/login and accidentally capture B.
  const generation = sessionGeneration;
  const scopeKeyAtStart = activeScopeKey;
  const signal = sessionController.signal;
  if (!scopeKeyAtStart || signal.aborted) return null;
  const context = await getOperatorContext();
  if (!context) return null;
  const scopeKey = operatorContextKey(context);
  if (
    generation !== sessionGeneration ||
    activeScopeKey !== scopeKeyAtStart ||
    scopeKey !== scopeKeyAtStart ||
    signal.aborted
  ) return null;
  return { generation, scopeKey, signal };
}

/** Reject continuations from a logout, revocation, or superseded operator scope. */
export function isSessionFenceCurrent(fence: SessionFence | null): fence is SessionFence {
  return (
    fence != null &&
    fence.generation === sessionGeneration &&
    fence.scopeKey === activeScopeKey &&
    !fence.signal.aborted
  );
}

export async function getToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  const epoch = credentialEpoch;
  let stored: string | null;
  try {
    stored = (await SecureStore.getItemAsync(TOKEN_KEY)) ?? null;
  } catch {
    // Keystore unavailable (e.g. simulator edge cases) — treat as signed out.
    stored = null;
  }
  // A clear or a newer in-memory write won while the native read was pending.
  // Never let the older keychain result republish that superseded credential.
  if (epoch !== credentialEpoch || cachedToken !== undefined) return cachedToken ?? null;
  cachedToken = stored;
  return cachedToken;
}

export async function getRefreshToken(): Promise<string | null> {
  if (cachedRefreshToken !== undefined) return cachedRefreshToken;
  const epoch = credentialEpoch;
  let stored: string | null;
  try {
    stored = (await SecureStore.getItemAsync(REFRESH_TOKEN_KEY)) ?? null;
  } catch {
    stored = null;
  }
  if (epoch !== credentialEpoch || cachedRefreshToken !== undefined) {
    return cachedRefreshToken ?? null;
  }
  cachedRefreshToken = stored;
  return cachedRefreshToken;
}

export async function setTokens(accessToken: string, refreshToken: string): Promise<void> {
  const epoch = credentialEpoch;
  return serializeCredentialWrite(async () => {
    if (epoch !== credentialEpoch) throw new Error('MOBILE_SESSION_CHANGED');
    const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
    await Promise.all([
      SecureStore.setItemAsync(TOKEN_KEY, accessToken, options),
      SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, options),
    ]);
    if (epoch !== credentialEpoch) throw new Error('MOBILE_SESSION_CHANGED');
    cachedToken = accessToken;
    cachedRefreshToken = refreshToken;
    for (const listener of tokenListeners) listener(accessToken);
  });
}

/** Rotate tokens only if the request still belongs to the captured session. */
export async function setTokensForSession(
  fence: SessionFence,
  accessToken: string,
  refreshToken: string,
): Promise<boolean> {
  const epoch = credentialEpoch;
  return serializeCredentialWrite(async () => {
    if (epoch !== credentialEpoch || !isSessionFenceCurrent(fence)) return false;
    const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
    await Promise.all([
      SecureStore.setItemAsync(TOKEN_KEY, accessToken, options),
      SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, options),
    ]);
    if (epoch !== credentialEpoch || !isSessionFenceCurrent(fence)) return false;
    cachedToken = accessToken;
    cachedRefreshToken = refreshToken;
    for (const listener of tokenListeners) listener(accessToken);
    return true;
  });
}

/** Subscribe to in-memory access-token rotations without persisting the token elsewhere. */
export function onAccessTokenChanged(
  listener: (token: string | null) => void,
): () => void {
  tokenListeners.add(listener);
  return () => {
    tokenListeners.delete(listener);
  };
}

function parseOperatorContext(raw: string | null): OperatorContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OperatorContext>;
    if (
      typeof parsed.organizationId !== 'string' ||
      parsed.organizationId.trim() === '' ||
      typeof parsed.actorId !== 'string' ||
      parsed.actorId.trim() === '' ||
      typeof parsed.businessPortalId !== 'string' ||
      parsed.businessPortalId.trim() === '' ||
      typeof parsed.tradeCode !== 'string' ||
      parsed.tradeCode.trim() === ''
    ) {
      return null;
    }
    return {
      organizationId: parsed.organizationId,
      actorId: parsed.actorId,
      businessPortalId: parsed.businessPortalId,
      tradeCode: parsed.tradeCode,
    };
  } catch {
    return null;
  }
}

export async function getOperatorContext(): Promise<OperatorContext | null> {
  if (cachedOperatorContext !== undefined) return cachedOperatorContext;
  const epoch = credentialEpoch;
  let stored: OperatorContext | null;
  try {
    stored = parseOperatorContext(await SecureStore.getItemAsync(OPERATOR_CONTEXT_KEY));
  } catch {
    stored = null;
  }
  if (epoch !== credentialEpoch || cachedOperatorContext !== undefined) {
    return cachedOperatorContext ?? null;
  }
  cachedOperatorContext = stored;
  return cachedOperatorContext;
}

export async function setOperatorContext(context: OperatorContext): Promise<void> {
  const epoch = credentialEpoch;
  const normalized = {
    organizationId: context.organizationId.trim(),
    actorId: context.actorId.trim(),
    businessPortalId: context.businessPortalId.trim(),
    tradeCode: context.tradeCode.trim(),
  };
  if (
    !normalized.organizationId ||
    !normalized.actorId ||
    !normalized.businessPortalId ||
    !normalized.tradeCode
  ) {
    throw new Error('MOBILE_CONTEXT_MISSING');
  }
  const nextScopeKey = operatorContextKey(normalized);
  const rotated = activeScopeKey !== nextScopeKey || sessionController.signal.aborted;
  if (rotated) rotateSessionFence(nextScopeKey);
  try {
    await serializeCredentialWrite(async () => {
      if (
        epoch !== credentialEpoch ||
        activeScopeKey !== nextScopeKey ||
        sessionController.signal.aborted
      ) {
        throw new Error('MOBILE_SESSION_CHANGED');
      }
      await SecureStore.setItemAsync(OPERATOR_CONTEXT_KEY, JSON.stringify(normalized), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      // Logout/revocation invalidates the fence synchronously, even while the native
      // keychain write is awaiting. Never republish that stale context afterwards;
      // the queued clear will remove the value that may just have landed on disk.
      if (
        epoch !== credentialEpoch ||
        activeScopeKey !== nextScopeKey ||
        sessionController.signal.aborted
      ) {
        throw new Error('MOBILE_SESSION_CHANGED');
      }
    });
  } catch (error) {
    if (rotated && activeScopeKey === nextScopeKey) rotateSessionFence(null);
    throw error;
  }
  cachedOperatorContext = normalized;
  emitOperatorContextChanged(normalized);
}

export async function clearSessionTokens(): Promise<void> {
  // Synchronous invalidation aborts in-flight HTTP/polls before native keychain IO.
  credentialEpoch += 1;
  rotateSessionFence(null);
  cachedToken = null;
  cachedRefreshToken = null;
  cachedOperatorContext = null;
  // Image sources and other in-memory consumers must drop the Bearer immediately;
  // native Keychain deletion may legitimately take longer or fail.
  for (const listener of tokenListeners) listener(null);
  emitOperatorContextChanged(null);
  await serializeCredentialWrite(async () => {
    const results = await Promise.allSettled([
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.deleteItemAsync(OPERATOR_CONTEXT_KEY),
    ]);
    // A set queued before this clear may have repopulated the memory cache while its
    // native write completed. Re-apply the terminal state inside the mutex so the
    // last serialized operation wins even when native deletion fails.
    cachedToken = null;
    cachedRefreshToken = null;
    cachedOperatorContext = null;
    for (const listener of tokenListeners) listener(null);
    emitOperatorContextChanged(null);
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('SECURE_SESSION_PURGE_FAILED');
    }
  });
}

// ── Username (the signed-in user, for stamping saved articles) ───────────────────

export async function setUsername(username: string): Promise<void> {
  const epoch = credentialEpoch;
  await serializeCredentialWrite(async () => {
    if (epoch !== credentialEpoch) throw new Error('MOBILE_SESSION_CHANGED');
    await SecureStore.setItemAsync(USERNAME_KEY, username, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (epoch !== credentialEpoch) throw new Error('MOBILE_SESSION_CHANGED');
    cachedUsername = username;
  });
}

export async function clearUsername(): Promise<void> {
  credentialEpoch += 1;
  cachedUsername = null;
  await serializeCredentialWrite(async () => {
    try {
      await SecureStore.deleteItemAsync(USERNAME_KEY);
    } finally {
      // Same queue-order guarantee as tokens: a preceding delayed set cannot win.
      cachedUsername = null;
    }
  });
}

/** Delete every persisted identity key, waiting for all native deletions before failing. */
export async function clearSessionCredentials(): Promise<void> {
  const results = await Promise.allSettled([clearSessionTokens(), clearUsername()]);
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('SECURE_SESSION_PURGE_FAILED');
  }
}

// ── Unauthenticated event (decoupled from React) ─────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();
const contextListeners = new Set<(context: OperatorContext | null) => void>();

/** Subscribe to "the session is no longer valid" (a 401 on an authenticated call). */
export function onUnauthenticated(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitUnauthenticated(): void {
  for (const listener of listeners) listener();
}

/** Keep React auth state current when the low-level API client rotates a session. */
export function onOperatorContextChanged(
  listener: (context: OperatorContext | null) => void,
): () => void {
  contextListeners.add(listener);
  return () => {
    contextListeners.delete(listener);
  };
}

function emitOperatorContextChanged(context: OperatorContext | null): void {
  for (const listener of contextListeners) listener(context);
}
