/**
 * Auth service — username/password → JWT, stored securely.
 *
 * Thin wrapper over the API client: it performs the credential exchange
 * (POST /v1/auth/login, no Authorization header) and persists the returned access
 * token via authStorage. Bearer attachment on every other request is handled
 * centrally in services/api.ts.
 */

import { apiRequest } from './api';
import { clearToken, clearUsername, setToken, setUsername } from './authStorage';

interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Exchange credentials for a token and store it. Throws (ApiError) on failure —
 * e.g. UNAUTHENTICATED for bad credentials — so the caller can show a message.
 */
export async function login(username: string, password: string): Promise<void> {
  const res = await apiRequest<LoginResponse>('/v1/auth/login', {
    method: 'POST',
    body: { username, password },
    skipAuth: true, // the login call must not carry (or react to) a stale token
  });
  if (!res?.access_token) {
    throw new Error('Login response did not include an access token');
  }
  await setToken(res.access_token);
  // Remember who signed in (not from the JWT — we never decode it) so saved articles
  // can be stamped with the author. Not a secret; cleared on logout.
  await setUsername(username);
}

export async function logout(): Promise<void> {
  await clearToken();
  await clearUsername();
}
