/**
 * Auth service — username/password → JWT, stored securely.
 *
 * Thin wrapper over the API client: it performs the credential exchange
 * (POST /v1/auth/login, no Authorization header) and persists the returned access
 * token via authStorage. Bearer attachment on every other request is handled
 * centrally in services/api.ts.
 */

import { apiRequest } from './api';
import {
  clearSessionTokens,
  clearUsername,
  getRefreshToken,
  setTokens,
  setUsername,
} from './authStorage';

interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  user: {
    role: 'admin' | 'operator';
  };
}

/**
 * Exchange credentials for a token and store it. Throws (ApiError) on failure —
 * e.g. UNAUTHENTICATED for bad credentials — so the caller can show a message.
 */
export async function login(username: string, password: string): Promise<void> {
  const res = await apiRequest<LoginResponse>(
    '/v1/mobile/auth/login',
    {
      method: 'POST',
      body: { username, password },
      skipAuth: true, // the login call must not carry (or react to) a stale token
    },
  );
  if (!res?.access_token || !res.refresh_token) {
    throw new Error('Login response did not include session tokens');
  }
  if (res.user.role !== 'operator') {
    throw new Error('MOBILE_OPERATOR_ONLY');
  }
  await setTokens(res.access_token, res.refresh_token);
  // Remember who signed in for the UI. Not a secret; cleared on logout.
  await setUsername(username);
}

export async function logout(): Promise<void> {
  const refreshToken = await getRefreshToken();
  try {
    if (refreshToken) {
      await apiRequest('/v1/mobile/auth/logout', {
        method: 'POST',
        body: { refresh_token: refreshToken },
        skipAuth: true,
      });
    }
  } finally {
    await clearSessionTokens();
    await clearUsername();
  }
}

export async function restoreAuthentication(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    await clearSessionTokens();
    return false;
  }
  try {
    const res = await apiRequest<LoginResponse>('/v1/mobile/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
      skipAuth: true,
    });
    if (!res.access_token || !res.refresh_token) {
      await clearSessionTokens();
      return false;
    }
    await setTokens(res.access_token, res.refresh_token);
    return true;
  } catch {
    await clearSessionTokens();
    return false;
  }
}
