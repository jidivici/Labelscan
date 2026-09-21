export const PROFESSION_CODES = [
  'poissonnerie',
  'boucherie',
  'charcuterie_traiteur',
] as const;

export type ProfessionCode = (typeof PROFESSION_CODES)[number];

export const CAPABILITIES = {
  WEB_ACCESS: 'web:access',
  ARRIVALS_READ: 'arrivals:read',
  STORE_SWITCH: 'store:switch',
  PROFESSION_SWITCH: 'profession:switch',
  OPERATORS_MANAGE: 'operators:manage',
  ADMIN_WORKSPACE_VIEW: 'admin-workspace:view',
  STORES_READ: 'stores:read',
  STORES_MANAGE: 'stores:manage',
  MANAGER_ASSIGNMENTS_MANAGE: 'manager-assignments:manage',
  SUPER_ADMIN_WORKSPACE_VIEW: 'super-admin-workspace:view',
  ADMINS_MANAGE: 'admins:manage',
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];
export type Role = 'super_admin' | 'admin' | 'manager';

export interface Store {
  organization_id?: string;
  id?: string;
  code: string;
  name: string;
  active: boolean;
}

interface SessionUser {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  store_code: string | null;
  organization_id: string;
  organization_slug: string;
  capabilities: Capability[];
  profession_codes: ProfessionCode[];
  accessible_stores: Store[];
  business_portal_ids: string[];
}

export interface Session {
  token: string;
  expiresAt: number;
  user: SessionUser;
}

interface SessionUserPayload extends Omit<
  SessionUser,
  'capabilities' | 'profession_codes' | 'accessible_stores' | 'business_portal_ids'
> {
  business_portal_ids?: string[];
  business_portal_id?: string | null;
  trade_code?: string | null;
  client_type?: string;
}

export interface AuthPayload {
  access_token: string;
  expires_in: number;
  user: SessionUserPayload;
}

interface BusinessPortalAccess {
  id: string;
  store_id: string;
  store_code: string;
  store_name: string;
  profession_code: string;
  profession_name: string;
  name: string;
  active: boolean;
}

export interface AccessOverviewPayload {
  user: User & { business_portal_ids: string[] };
  capabilities: string[];
  scopes: string[];
  stores: Store[];
  business_portals: BusinessPortalAccess[];
}

interface User {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  store_code: string | null;
  active: boolean;
  created_at: string;
}

export interface Arrival {
  batch_id: string;
  store_code: string | null;
  profession_code?: ProfessionCode;
  product_name: string | null;
  scientific_name: string | null;
  gtin: string | null;
  lot_code: string;
  supplier_name: string | null;
  status: string;
  fao_area_code: string | null;
  production_method: string | null;
  use_by: string | null;
  packaging_date: string | null;
  recorded_at: string;
  photo_available: boolean;
  photo_rotation_degrees?: 0 | 180;
  photo_base_rotation_degrees?: -90 | 0;
  store_id?: string | null;
  business_portal_id?: string | null;
  trade_profile_version?: string;
  captured_by_user_id?: string | null;
  completeness?: number;
  operator_id?: string | null;
  operator_name?: string | null;
}

export interface ArrivalDetail {
  batch_id: string;
  ingestion_id: string;
  store_code: string | null;
  profession_code?: ProfessionCode;
  status: string;
  fields: Record<string, string | null>;
  validation: Record<string, { source?: string; validation_status?: string }>;
  revision_no: number;
  recorded_at: string;
  updated_at: string;
  photo_available: boolean;
  photo_rotation_degrees?: 0 | 180;
  photo_base_rotation_degrees?: -90 | 0;
  store_id?: string | null;
  business_portal_id?: string | null;
  trade_profile_version?: string;
  captured_by_user_id?: string | null;
  captured_by_user_name?: string | null;
  completeness?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ArrivalFilters {
  query: string;
  storeCode: string;
  status: string;
  supplier: string;
  lotCode: string;
  gtin: string;
  dateFrom: string;
  dateTo: string;
  expiryFrom: string;
  expiryTo: string;
  sortBy: string;
  sortDirection: 'asc' | 'desc';
  fieldFilters: ArrivalFieldFilter[];
  view: 'table' | 'cards';
  page: number;
}

export interface ArrivalFieldFilter {
  field: string;
  value: string;
}
