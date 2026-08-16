import { useQuery } from '@tanstack/react-query';

import { API_BASE_URL } from '../config';
import { businessProfileFor } from './businessProfiles';
import { apiRequest } from './api';
import { getToken } from './authStorage';
import type { Article, ArticleField } from '../types/Article';

interface ArrivalSummary {
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
  photo_rotation_degrees?: 0 | 180;
  business_portal_id: string | null;
  profession_code: string;
  trade_profile_version: string;
}

interface ArrivalPage {
  items: ArrivalSummary[];
  total: number;
}

interface ArrivalDetail {
  batch_id: string;
  ingestion_id: string;
  store_code: string | null;
  status: string;
  fields: Record<string, string | null>;
  validation: Record<
    string,
    {
      validation_status?: string;
      confidence?: number;
      confidence_band?: string;
      source?: string;
    }
  >;
  revision_no: number;
  recorded_at: string;
  updated_at: string;
  photo_available: boolean;
  photo_rotation_degrees?: 0 | 180;
  business_portal_id: string | null;
  profession_code: string;
  trade_profile_version: string;
}

function fieldsFromValues(
  values: Record<string, string | null>,
  validation: ArrivalDetail['validation'] = {},
  tradeCode?: string | null,
): ArticleField[] {
  const canonical = businessProfileFor(tradeCode).fields;
  // Profile fields first, then unexpected historical keys verbatim so old records
  // remain inspectable after profile evolution.
  const names = [...canonical, ...Object.keys(values).filter((name) => !canonical.includes(name))];
  return names.map((field_name) => {
    const metadata = validation[field_name];
    return {
      field_name,
      value: values[field_name] ?? null,
      validation_status:
        (metadata?.validation_status as ArticleField['validation_status']) ??
        (values[field_name] ? 'present' : 'missing'),
      combined_confidence: Number(metadata?.confidence ?? 1),
      confidence_band:
        (metadata?.confidence_band as ArticleField['confidence_band']) ?? 'high',
      edited: metadata?.source === 'human' || undefined,
    };
  });
}

async function imageHeaders(): Promise<Record<string, string> | undefined> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export async function listCatalogArticles(): Promise<Article[]> {
  const page = await apiRequest<ArrivalPage>('/v1/arrivals?limit=200');
  const headers = await imageHeaders();
  return page.items.map((arrival) => {
    const values: Record<string, string | null> = {
      commercial_designation: arrival.product_name,
      reseller_brand: arrival.supplier_name,
      batch_number: arrival.lot_code,
      expiry_date: arrival.use_by,
      packaging_date: arrival.packaging_date,
      gtin: arrival.gtin,
    };
    if (arrival.profession_code === 'poissonnerie') {
      values.scientific_name = arrival.scientific_name;
      values.FAO_area = arrival.fao_area_code;
      values.production_method = arrival.production_method;
    }
    return {
      id: arrival.batch_id,
      source: 'backend_extraction',
      ingestion_id: '',
      extraction_run_id: null,
      captured_at: arrival.recorded_at,
      photo_uri: arrival.photo_available
        ? `${API_BASE_URL}/v1/arrivals/${encodeURIComponent(arrival.batch_id)}/image`
        : null,
      photo_headers: headers,
      photo_rotation_degrees: arrival.photo_rotation_degrees ?? 0,
      barcode_raw: arrival.gtin,
      ingestion_status: arrival.status,
      fields: fieldsFromValues(values, {}, arrival.profession_code),
      saved_at: arrival.recorded_at,
      saved_by: null,
      business_portal_id: arrival.business_portal_id,
      trade_code: arrival.profession_code,
      trade_profile_version: arrival.trade_profile_version,
    };
  });
}

export async function getCatalogArticle(batchId: string): Promise<Article | null> {
  try {
    const arrival = await apiRequest<ArrivalDetail>(
      `/v1/arrivals/${encodeURIComponent(batchId)}`,
    );
    const headers = await imageHeaders();
    return {
      id: arrival.batch_id,
      source: 'backend_extraction',
      ingestion_id: arrival.ingestion_id,
      extraction_run_id: null,
      captured_at: arrival.recorded_at,
      photo_uri: arrival.photo_available
        ? `${API_BASE_URL}/v1/arrivals/${encodeURIComponent(arrival.batch_id)}/image`
        : null,
      photo_headers: headers,
      photo_rotation_degrees: arrival.photo_rotation_degrees ?? 0,
      barcode_raw: arrival.fields.gtin ?? null,
      ingestion_status: arrival.status,
      fields: fieldsFromValues(
        arrival.fields,
        arrival.validation,
        arrival.profession_code,
      ),
      saved_at: arrival.updated_at,
      saved_by: null,
      business_portal_id: arrival.business_portal_id,
      trade_code: arrival.profession_code,
      trade_profile_version: arrival.trade_profile_version,
    };
  } catch {
    return null;
  }
}

export function useCatalogArticles() {
  return useQuery({
    queryKey: ['catalog', 'arrivals'],
    queryFn: listCatalogArticles,
  });
}
