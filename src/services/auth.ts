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
  setOperatorContext,
  setTokens,
  setUsername,
  type OperatorContext,
} from './authStorage';
import { isTradeCode } from './businessProfiles';

interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  user: {
    role: 'admin' | 'manager' | 'super_admin';
    username: string;
    business_portal_id: string | null;
    trade_code: string | null;
  };
}

export interface OperatorSession extends OperatorContext {
  username: string;
}

function operatorSession(response: LoginResponse): OperatorSession {
  // The capture/review app is intentionally manager-only. Administrators use
  // the secured web portal for arrivals, stores and manager administration.
  if (response.user.role !== 'manager') {
    throw new Error('MOBILE_ACCESS_DENIED');
  }
  if (
    typeof response.user.username !== 'string' ||
    response.user.username.trim() === '' ||
    typeof response.user.business_portal_id !== 'string' ||
    response.user.business_portal_id.trim() === '' ||
    !isTradeCode(response.user.trade_code)
  ) {
    throw new Error('MOBILE_CONTEXT_MISSING');
  }
  return {
    username: response.user.username,
    businessPortalId: response.user.business_portal_id,
    tradeCode: response.user.trade_code,
  };
}

async function persistSession(
  response: LoginResponse,
  fallbackUsername?: string,
): Promise<OperatorSession> {
  if (!response?.access_token || !response.refresh_token) {
    throw new Error('Login response did not include session tokens');
  }
  const session = operatorSession(response);
  try {
    await Promise.all([
      setTokens(response.access_token, response.refresh_token),
      setUsername(session.username || fallbackUsername || ''),
      setOperatorContext({
        businessPortalId: session.businessPortalId,
        tradeCode: session.tradeCode,
      }),
    ]);
  } catch (error) {
    // SecureStore writes are independent native calls: fail closed if only part of
    // the session landed, otherwise a token could survive without its portal context.
    await Promise.allSettled([clearSessionTokens(), clearUsername()]);
    throw error;
  }
  return session;
}

/**
 * Exchange credentials for a token and store it. Throws (ApiError) on failure —
 * e.g. UNAUTHENTICATED for bad credentials — so the caller can show a message.
 */
export async function login(username: string, password: string): Promise<OperatorSession> {
  const res = await apiRequest<LoginResponse>(
    '/v1/mobile/auth/login',
    {
      method: 'POST',
      body: { username, password },
      skipAuth: true, // the login call must not carry (or react to) a stale token
    },
  );
  return persistSession(res, username);
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

export async function restoreAuthentication(): Promise<OperatorSession | null> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    await clearSessionTokens();
    return null;
  }
  try {
    const res = await apiRequest<LoginResponse>('/v1/mobile/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
      skipAuth: true,
    });
    if (!res.access_token || !res.refresh_token) {
      await clearSessionTokens();
      return null;
    }
    return await persistSession(res);
  } catch {
    await clearSessionTokens();
    return null;
  }
}
