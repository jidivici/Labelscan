import type { Session } from './types';

export class ApiProblem extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  session?: Session | null,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiProblem(body.error_code ?? `HTTP_${response.status}`, body.detail ?? 'Erreur serveur');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function organizationSlug(): string {
  const match = window.location.pathname.match(/\/backoffice\/o\/([^/]+)/);
  return decodeURIComponent(match?.[1] ?? 'labelscan');
}
