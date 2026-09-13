/**
 * Auth service — username/password → JWT, stored securely.
 *
 * Thin wrapper over the API client: it performs the credential exchange
 * (POST /v1/auth/login, no Authorization header) and persists the returned access
 * token via authStorage. Bearer attachment on every other request is handled
 * centrally in services/api.ts.
 */

import { ApiError, apiRequest } from './api';
import {
  clearSessionCredentials,
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
    id: string;
    role: 'admin' | 'manager' | 'super_admin';
    username: string;
    organization_id: string | null;
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
    typeof response.user.id !== 'string' ||
    response.user.id.trim() === '' ||
    typeof response.user.organization_id !== 'string' ||
    response.user.organization_id.trim() === '' ||
    typeof response.user.business_portal_id !== 'string' ||
    response.user.business_portal_id.trim() === '' ||
    !isTradeCode(response.user.trade_code)
  ) {
    throw new Error('MOBILE_CONTEXT_MISSING');
  }
  return {
    username: response.user.username,
    organizationId: response.user.organization_id,
    actorId: response.user.id,
    businessPortalId: response.user.business_portal_id,
    tradeCode: response.user.trade_code,
  };
}

async function persistSession(
  response: LoginResponse,
  fallbackUsername?: string,
  signal?: AbortSignal,
): Promise<OperatorSession> {
  throwIfRestoreAborted(signal);
  if (!response?.access_token || !response.refresh_token) {
    throw new Error('Login response did not include session tokens');
  }
  const session = operatorSession(response);
  try {
    await Promise.all([
      setTokens(response.access_token, response.refresh_token),
      setUsername(session.username || fallbackUsername || ''),
      setOperatorContext({
        organizationId: session.organizationId,
        actorId: session.actorId,
        businessPortalId: session.businessPortalId,
        tradeCode: session.tradeCode,
      }),
    ]);
  } catch (error) {
    // A canceled bootstrap may have been superseded by logout or another login.
    // Its queued writes are fenced by authStorage; never purge the newer session.
    throwIfRestoreAborted(signal);
    // SecureStore writes are independent native calls: fail closed if only part of
    // the session landed, otherwise a token could survive without its portal context.
    await clearSessionCredentials();
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
  // Local logout is authoritative and completes before a potentially slow remote
  // revocation. If the process is killed during the POST, no credential can restore.
  await clearSessionCredentials();
  try {
    if (refreshToken) {
      await apiRequest('/v1/mobile/auth/logout', {
        method: 'POST',
        body: { refresh_token: refreshToken },
        skipAuth: true,
      });
    }
  } catch {
    // The captured refresh token expires server-side; local sign-out remains complete.
  }
}

/** Only a temporary connection/service failure may retain a boot credential. */
export function isAuthenticationRestoreRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status === 401 || error.status === 403) return false;
  return error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT'
    || error.status === 408 || error.status === 429 || error.status >= 500;
}

function throwIfRestoreAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Authentication restoration canceled');
  error.name = 'AbortError';
  throw error;
}

export async function restoreAuthentication(
  { signal }: { signal?: AbortSignal } = {},
): Promise<OperatorSession | null> {
  throwIfRestoreAborted(signal);
  const refreshToken = await getRefreshToken();
  throwIfRestoreAborted(signal);
  if (!refreshToken) {
    await clearSessionCredentials();
    return null;
  }
  try {
    const res = await apiRequest<LoginResponse>('/v1/mobile/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
      skipAuth: true,
      ...(signal ? { signal } : {}),
    });
    throwIfRestoreAborted(signal);
    if (!res.access_token || !res.refresh_token) {
      await clearSessionCredentials();
      return null;
    }
    return await persistSession(res, undefined, signal);
  } catch (error) {
    // apiRequest reports caller aborts as TIMEOUT. Cancellation must never
    // clear credentials or schedule another attempt from this bootstrap.
    throwIfRestoreAborted(signal);
    // A late Wi-Fi connection is not evidence of an expired/revoked session.
    // Keep the secure credential, but do not admit the user until refresh succeeds.
    if (isAuthenticationRestoreRetryable(error)) throw error;
    await clearSessionCredentials();
    return null;
  }
}
