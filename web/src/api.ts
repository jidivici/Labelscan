import type { Session } from './types';

export class ApiProblem extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

let refreshPromise: Promise<Session | null> | null = null;

export async function refreshBrowserSession(): Promise<Session | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetch('/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) return null;
      const body = await response.json();
      return {
        token: body.access_token,
        expiresAt: Date.now() + body.expires_in * 1000,
        user: body.user,
      } as Session;
    })
    .catch(() => null);
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export async function request<T>(
  path: string,
  session?: Session | null,
  init: RequestInit = {},
): Promise<T> {
  const response = await authorizedFetch(path, session, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiProblem(body.error_code ?? `HTTP_${response.status}`, body.detail ?? 'Erreur serveur');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function authorizedFetch(
  path: string,
  session?: Session | null,
  init: RequestInit = {},
  authRetried = false,
): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      ...init.headers,
    },
    credentials: 'same-origin',
  });
  if (response.status === 401 && session && !authRetried) {
    const refreshed = await refreshBrowserSession();
    if (refreshed) {
      session.token = refreshed.token;
      session.expiresAt = refreshed.expiresAt;
      session.user = refreshed.user;
      return authorizedFetch(path, session, init, true);
    }
  }
  return response;
}

export function organizationSlug(): string {
  const match = window.location.pathname.match(/\/backoffice\/o\/([^/]+)/);
  return decodeURIComponent(match?.[1] ?? 'labelscan');
}
