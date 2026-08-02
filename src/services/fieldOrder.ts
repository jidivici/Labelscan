/**
 * Canonical field display order — SHARED by the registration (ReviewScreen) and the
 * article detail (ArticleDetailScreen) screens, so the whole app reads fields in ONE
 * consistent order end-to-end. The groups are presentation metadata only: canonical
 * field names and persisted payloads remain unchanged.
 *
 * Mirrors the LLM closed field set (claude_llm_provider._FIELD_NAMES, prompt v2.0.0).
 * A field not listed here still renders — appended after these, in its own array order.
 */
export const FIELD_GROUPS = [
  {
    id: 'identity',
    title: 'Identification du produit',
    fields: [
      'commercial_designation',
      'scientific_name',
      'producer_name',
      'reseller_brand',
    ],
  },
  {
    id: 'provenance',
    title: 'Provenance et production',
    fields: [
      'origin_country',
      'FAO_area',
      'production_method',
      'fishing_gear_or_farming_method',
    ],
  },
  {
    id: 'traceability',
    title: 'Traçabilité réglementaire',
    fields: [
      'batch_number',
      'health_mark',
      'gtin',
    ],
  },
  {
    id: 'haccp',
    title: 'HACCP, dates et conservation',
    fields: [
      'packaging_date',
      'expiry_date',
      'storage_temperature',
      'allergens',
    ],
  },
  {
    id: 'commercial',
    title: 'Données commerciales',
    fields: [
      'weight',
      'price',
    ],
  },
] as const;

export const FIELD_ORDER = FIELD_GROUPS.flatMap((group) => group.fields);
