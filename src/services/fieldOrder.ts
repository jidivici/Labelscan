/**
 * Canonical field display order — SHARED by the registration (ReviewScreen) and the
 * article detail (ArticleDetailScreen) screens, so the whole app reads fields in ONE
 * consistent order end-to-end. Readable HACCP order:
 *   identity → method/origin → sanitary → lot/dates → conservation.
 *
 * Mirrors the LLM closed field set (claude_llm_provider._FIELD_NAMES, prompt v2.0.0).
 * A field not listed here still renders — appended after these, in its own array order.
 */
export const FIELD_ORDER = [
  'commercial_designation',
  'scientific_name',
  'producer_name',
  'reseller_brand',
  'production_method',
  'fishing_gear_or_farming_method',
  'FAO_area',
  'origin_country',
  'health_mark',
  'batch_number',
  'expiry_date',
  'packaging_date',
  'storage_temperature',
  'weight',
  'allergens',
  'price',
  'gtin',
] as const;
