import type {
  AccessOverviewPayload,
  Arrival,
  ArrivalDetail,
  ArrivalFilters,
  ArrivalMetrics,
  AuthPayload,
  Page,
  ProfessionCode,
  Session,
} from './types';

export class ApiProblem extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

let refreshPromise: Promise<AuthPayload | null> | null = null;

export async function refreshBrowserSessionPayload(): Promise<AuthPayload | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetch('/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then(async (response) => response.ok ? response.json() as Promise<AuthPayload> : null)
    .catch(() => null);
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export async function browserLogin(
  organizationSlug: string,
  username: string,
  password: string,
): Promise<AuthPayload> {
  return request<AuthPayload>(
    `/v1/o/${encodeURIComponent(organizationSlug)}/auth/login`,
    null,
    { method: 'POST', body: JSON.stringify({ username, password }) },
  );
}

export async function browserLogout(): Promise<void> {
  await fetch('/v1/auth/logout', { method: 'POST', credentials: 'same-origin' });
}

export async function getAccessOverview(session: Session): Promise<AccessOverviewPayload> {
  return request<AccessOverviewPayload>('/v1/me', session);
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
    const refreshed = await refreshBrowserSessionPayload();
    if (refreshed) {
      session.token = refreshed.access_token;
      session.expiresAt = Date.now() + refreshed.expires_in * 1000;
      return authorizedFetch(path, session, init, true);
    }
  }
  return response;
}

export async function listArrivals(
  session: Session,
  profession: ProfessionCode,
  filters: ArrivalFilters,
  signal?: AbortSignal,
): Promise<Page<Arrival>> {
  const limit = 50;
  const params = arrivalQueryParams(profession, filters, { limit, offset: (filters.page - 1) * limit });
  return request<Page<Arrival>>(`/v1/arrivals?${params}`, session, { signal });
}

interface ArrivalQueryOptions {
  limit: number;
  offset: number;
  status?: string;
  alertState?: string;
  completenessMin?: string;
}

export function arrivalQueryParams(
  profession: ProfessionCode,
  filters: ArrivalFilters,
  options: ArrivalQueryOptions,
): URLSearchParams {
  const params = new URLSearchParams({ profession, limit: String(options.limit), offset: String(options.offset) });
  if (filters.query) params.set('q', filters.query);
  if (filters.storeCode) params.set('store_code', filters.storeCode);
  const status = options.status ?? filters.status;
  const alertState = options.alertState ?? filters.alertState;
  const completenessMin = options.completenessMin ?? filters.completenessMin;
  if (status) params.set('status', status);
  if (filters.supplier) params.set('supplier', filters.supplier);
  if (filters.lotCode) params.set('lot_code', filters.lotCode);
  if (filters.gtin) params.set('gtin', filters.gtin);
  if (alertState) params.set('alert_state', alertState);
  if (completenessMin) params.set('completeness_min', completenessMin);
  if (filters.dateFrom) params.set('date_from', filters.dateFrom);
  if (filters.dateTo) params.set('date_to', filters.dateTo);
  if (filters.expiryFrom) params.set('expiry_from', filters.expiryFrom);
  if (filters.expiryTo) params.set('expiry_to', filters.expiryTo);
  if (filters.sortBy) params.set('sort_by', filters.sortBy);
  if (filters.sortDirection) params.set('sort_direction', filters.sortDirection);
  for (const filter of filters.fieldFilters) params.append('field_filter', `${filter.field}:${filter.value}`);
  return params;
}

async function arrivalMetricTotal(
  session: Session,
  profession: ProfessionCode,
  filters: ArrivalFilters,
  overrides: Partial<Pick<ArrivalQueryOptions, 'status' | 'alertState' | 'completenessMin'>>,
  signal?: AbortSignal,
): Promise<number> {
  const params = arrivalQueryParams(profession, filters, { limit: 1, offset: 0, ...overrides });
  const page = await request<Page<Arrival>>(`/v1/arrivals?${params}`, session, { signal });
  return page.total;
}

export async function getArrivalMetrics(
  session: Session,
  profession: ProfessionCode,
  filters: ArrivalFilters,
  signal?: AbortSignal,
): Promise<ArrivalMetrics> {
  const [total, flagged, openAlerts, complete] = await Promise.all([
    arrivalMetricTotal(session, profession, filters, {}, signal),
    arrivalMetricTotal(session, profession, filters, { status: 'flagged' }, signal),
    arrivalMetricTotal(session, profession, filters, { alertState: 'open' }, signal),
    arrivalMetricTotal(session, profession, filters, { completenessMin: '100' }, signal),
  ]);
  return { total, flagged, openAlerts, incomplete: Math.max(0, total - complete) };
}

export async function getArrival(
  session: Session,
  batchId: string,
  signal?: AbortSignal,
): Promise<ArrivalDetail> {
  return request<ArrivalDetail>(`/v1/arrivals/${encodeURIComponent(batchId)}`, session, { signal });
}

export function arrivalImagePath(batchId: string): string {
  return `/v1/arrivals/${encodeURIComponent(batchId)}/image`;
}
