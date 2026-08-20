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

/** Server-authoritative assignment attached to every mobile operator session. */
export interface OperatorContext {
  businessPortalId: string;
  tradeCode: string;
}

export async function getToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  try {
    cachedToken = (await SecureStore.getItemAsync(TOKEN_KEY)) ?? null;
  } catch {
    // Keystore unavailable (e.g. simulator edge cases) — treat as signed out.
    cachedToken = null;
  }
  return cachedToken;
}

export async function getRefreshToken(): Promise<string | null> {
  if (cachedRefreshToken !== undefined) return cachedRefreshToken;
  try {
    cachedRefreshToken = (await SecureStore.getItemAsync(REFRESH_TOKEN_KEY)) ?? null;
  } catch {
    cachedRefreshToken = null;
  }
  return cachedRefreshToken;
}

export async function setTokens(accessToken: string, refreshToken: string): Promise<void> {
  cachedToken = accessToken;
  cachedRefreshToken = refreshToken;
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  await Promise.all([
    SecureStore.setItemAsync(TOKEN_KEY, accessToken, options),
    SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken, options),
  ]);
}

function parseOperatorContext(raw: string | null): OperatorContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OperatorContext>;
    if (
      typeof parsed.businessPortalId !== 'string' ||
      parsed.businessPortalId.trim() === '' ||
      typeof parsed.tradeCode !== 'string' ||
      parsed.tradeCode.trim() === ''
    ) {
      return null;
    }
    return {
      businessPortalId: parsed.businessPortalId,
      tradeCode: parsed.tradeCode,
    };
  } catch {
    return null;
  }
}

export async function getOperatorContext(): Promise<OperatorContext | null> {
  if (cachedOperatorContext !== undefined) return cachedOperatorContext;
  try {
    cachedOperatorContext = parseOperatorContext(
      await SecureStore.getItemAsync(OPERATOR_CONTEXT_KEY),
    );
  } catch {
    cachedOperatorContext = null;
  }
  return cachedOperatorContext;
}

export async function setOperatorContext(context: OperatorContext): Promise<void> {
  const normalized = {
    businessPortalId: context.businessPortalId.trim(),
    tradeCode: context.tradeCode.trim(),
  };
  if (!normalized.businessPortalId || !normalized.tradeCode) {
    throw new Error('MOBILE_CONTEXT_MISSING');
  }
  await SecureStore.setItemAsync(OPERATOR_CONTEXT_KEY, JSON.stringify(normalized), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  cachedOperatorContext = normalized;
  emitOperatorContextChanged(normalized);
}

export async function clearSessionTokens(): Promise<void> {
  cachedToken = null;
  cachedRefreshToken = null;
  cachedOperatorContext = null;
  await Promise.allSettled([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
    SecureStore.deleteItemAsync(OPERATOR_CONTEXT_KEY),
  ]);
  emitOperatorContextChanged(null);
}

// ── Username (the signed-in user, for stamping saved articles) ───────────────────

export async function setUsername(username: string): Promise<void> {
  cachedUsername = username;
  await SecureStore.setItemAsync(USERNAME_KEY, username, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearUsername(): Promise<void> {
  cachedUsername = null;
  try {
    await SecureStore.deleteItemAsync(USERNAME_KEY);
  } catch {
    // Best-effort: the in-memory cache is already cleared.
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
