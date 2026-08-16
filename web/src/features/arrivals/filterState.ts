import type { ArrivalFieldFilter, ArrivalFilters } from '../../types';

const POSITIVE_INTEGER = /^[1-9]\d*$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type ScalarArrivalFilterKey = Exclude<keyof ArrivalFilters, 'fieldFilters'>;

const QUERY_KEYS: Record<ScalarArrivalFilterKey, string> = {
  query: 'q',
  storeCode: 'store',
  status: 'status',
  supplier: 'supplier',
  lotCode: 'lot',
  gtin: 'gtin',
  dateFrom: 'from',
  dateTo: 'to',
  expiryFrom: 'expiry_from',
  expiryTo: 'expiry_to',
  sortBy: 'sort',
  sortDirection: 'direction',
  view: 'view',
  page: 'page',
};

function parseFieldFilter(raw: string): ArrivalFieldFilter | null {
  const separator = raw.indexOf(':');
  if (separator < 1) return null;
  const field = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1).trim();
  return FIELD_NAME.test(field) && value ? { field, value } : null;
}

export function parseArrivalFilters(params: URLSearchParams): ArrivalFilters {
  const page = params.get('page') ?? '';
  return {
    // Preserve the value while the controlled search field is being edited.
    // Trimming here would remove a just-typed trailing space before the next word.
    query: params.get('q') ?? '',
    storeCode: params.get('store')?.trim() ?? '',
    status: '',
    supplier: params.get('supplier')?.trim() ?? '',
    lotCode: params.get('lot')?.trim() ?? '',
    gtin: params.get('gtin')?.trim() ?? '',
    dateFrom: params.get('from') ?? '',
    dateTo: params.get('to') ?? '',
    expiryFrom: params.get('expiry_from') ?? '',
    expiryTo: params.get('expiry_to') ?? '',
    sortBy: params.get('sort')?.trim() || 'recorded_at',
    sortDirection: params.get('direction') === 'asc' ? 'asc' : 'desc',
    fieldFilters: params.getAll('field_filter').map(parseFieldFilter).filter((value): value is ArrivalFieldFilter => value !== null),
    view: params.get('view') === 'table' ? 'table' : 'cards',
    page: POSITIVE_INTEGER.test(page) ? Number(page) : 1,
  };
}

function isDefaultValue(key: ScalarArrivalFilterKey, value: string | number): boolean {
  return !value
    || (key === 'page' && value === 1)
    || (key === 'view' && value === 'cards')
    || (key === 'sortBy' && value === 'recorded_at')
    || (key === 'sortDirection' && value === 'desc');
}

export function updateArrivalFilter(
  current: URLSearchParams,
  key: ScalarArrivalFilterKey,
  value: string | number,
): URLSearchParams {
  const next = new URLSearchParams(current);
  const target = QUERY_KEYS[key];
  if (isDefaultValue(key, value)) next.delete(target);
  else next.set(target, String(value));
  if (key !== 'page' && key !== 'view') next.delete('page');
  return next;
}

export function updatePortalFieldFilter(
  current: URLSearchParams,
  field: string,
  value: string,
): URLSearchParams {
  if (!FIELD_NAME.test(field)) return new URLSearchParams(current);
  const retained = current.getAll('field_filter')
    .map(parseFieldFilter)
    .filter((filter): filter is ArrivalFieldFilter => filter !== null && filter.field !== field);
  if (value.trim()) retained.push({ field, value: value.trim() });
  const next = new URLSearchParams(current);
  next.delete('field_filter');
  for (const filter of retained) next.append('field_filter', `${filter.field}:${filter.value}`);
  next.delete('page');
  return next;
}

export function clearArrivalFilters(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  const query = current.get('q');
  const view = current.get('view');
  if (query) next.set('q', query);
  if (view === 'table') next.set('view', view);
  return next;
}

export function activeArrivalFilterCount(filters: ArrivalFilters): number {
  return [
    filters.storeCode,
    filters.supplier,
    filters.lotCode,
    filters.gtin,
    filters.dateFrom,
    filters.dateTo,
    filters.expiryFrom,
    filters.expiryTo,
    ...filters.fieldFilters.map((filter) => filter.value),
  ].filter(Boolean).length;
}
