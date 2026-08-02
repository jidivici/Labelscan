export type Role = 'admin' | 'operator';
export interface SessionUser {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  store_code: string | null;
  organization_id: string;
  organization_slug: string;
}
export interface Session {
  token: string;
  expiresAt: number;
  user: SessionUser;
}
export interface Store {
  organization_id?: string;
  code: string;
  name: string;
  active: boolean;
}
export interface User {
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
}
export interface ArrivalDetail {
  batch_id: string;
  ingestion_id: string;
  store_code: string | null;
  status: string;
  fields: Record<string, string | null>;
  validation: Record<string, { source?: string; validation_status?: string }>;
  revision_no: number;
  recorded_at: string;
  updated_at: string;
  photo_available: boolean;
}
