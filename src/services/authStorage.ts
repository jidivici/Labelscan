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
// The username is NOT a secret, but it shares the token's lifecycle (set on login,
// cleared on logout) so we keep it in the same store to avoid a second mechanism.
const USERNAME_KEY = 'labelscan.username';

// undefined = not yet loaded from the keystore; null = loaded, no token.
let cachedToken: string | null | undefined;
let cachedUsername: string | null | undefined;

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

export async function setToken(token: string): Promise<void> {
  cachedToken = token;
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  cachedToken = null;
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Best-effort: the in-memory cache is already cleared.
  }
}

// ── Username (the signed-in user, for stamping saved articles) ───────────────────

export async function getUsername(): Promise<string | null> {
  if (cachedUsername !== undefined) return cachedUsername;
  try {
    cachedUsername = (await SecureStore.getItemAsync(USERNAME_KEY)) ?? null;
  } catch {
    cachedUsername = null;
  }
  return cachedUsername;
}

export async function setUsername(username: string): Promise<void> {
  cachedUsername = username;
  await SecureStore.setItemAsync(USERNAME_KEY, username);
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
