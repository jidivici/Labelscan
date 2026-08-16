/**
 * Versioned mobile presentation contracts for the three supported trades.
 *
 * The server remains authoritative for the operator's assignment. These constants
 * only describe how the SDK-54 client renders and reviews the trade code received
 * at login/refresh; the client never chooses or sends a portal with an ingestion.
 */

export type TradeCode = 'poissonnerie' | 'boucherie' | 'charcuterie_traiteur';

export interface FieldGroup {
  id: 'identity' | 'provenance' | 'traceability' | 'haccp' | 'commercial';
  title: string;
  fields: readonly string[];
}

export interface BusinessProfile {
  code: TradeCode;
  displayName: string;
  version: '1';
  groups: readonly FieldGroup[];
  fields: readonly string[];
  requiredFields: readonly string[];
}

function profile(
  code: TradeCode,
  displayName: string,
  groups: readonly FieldGroup[],
  requiredFields: readonly string[],
): BusinessProfile {
  return {
    code,
    displayName,
    version: '1',
    groups,
    fields: groups.flatMap((group) => group.fields),
    requiredFields,
  };
}

export const BUSINESS_PROFILES: Readonly<Record<TradeCode, BusinessProfile>> = {
  poissonnerie: profile(
    'poissonnerie',
    'Poissonnerie',
    [
      {
        id: 'identity',
        title: 'Identification du produit',
        fields: ['commercial_designation', 'scientific_name', 'producer_name', 'reseller_brand'],
      },
      {
        id: 'provenance',
        title: 'Provenance et production',
        fields: ['origin_country', 'FAO_area', 'production_method', 'fishing_gear_or_farming_method'],
      },
      {
        id: 'traceability',
        title: 'Traçabilité réglementaire',
        fields: ['batch_number', 'health_mark', 'gtin'],
      },
      {
        id: 'haccp',
        title: 'HACCP, dates et conservation',
        fields: ['packaging_date', 'expiry_date', 'storage_temperature', 'allergens'],
      },
      {
        id: 'commercial',
        title: 'Données commerciales',
        fields: ['weight', 'price'],
      },
    ],
    ['scientific_name', 'expiry_date', 'production_method'],
  ),
  boucherie: profile(
    'boucherie',
    'Boucherie',
    [
      {
        id: 'identity',
        title: 'Identification de la viande',
        fields: [
          'commercial_designation',
          'animal_species',
          'animal_category',
          'cut_name',
          'producer_name',
          'reseller_brand',
        ],
      },
      {
        id: 'provenance',
        title: 'Origine et parcours de l’animal',
        fields: [
          'origin_country',
          'birth_country',
          'rearing_country',
          'slaughter_country',
          'cutting_country',
        ],
      },
      {
        id: 'traceability',
        title: 'Traçabilité réglementaire',
        fields: [
          'batch_number',
          'health_mark',
          'slaughterhouse_approval',
          'cutting_plant_approval',
          'gtin',
        ],
      },
      {
        id: 'haccp',
        title: 'HACCP, dates et conservation',
        fields: ['packaging_date', 'expiry_date', 'storage_temperature', 'allergens'],
      },
      {
        id: 'commercial',
        title: 'Données commerciales',
        fields: ['weight', 'price'],
      },
    ],
    ['animal_species', 'cut_name', 'expiry_date'],
  ),
  charcuterie_traiteur: profile(
    'charcuterie_traiteur',
    'Charcuterie / Traiteur',
    [
      {
        id: 'identity',
        title: 'Identification du produit',
        fields: [
          'commercial_designation',
          'product_family',
          'manufacturer_name',
          'producer_name',
          'reseller_brand',
        ],
      },
      {
        id: 'provenance',
        title: 'Origine',
        fields: ['origin_country'],
      },
      {
        id: 'traceability',
        title: 'Traçabilité réglementaire',
        fields: ['batch_number', 'health_mark', 'gtin'],
      },
      {
        id: 'haccp',
        title: 'Composition, préparation et conservation',
        fields: [
          'ingredients',
          'additives',
          'allergens',
          'preparation_date',
          'packaging_date',
          'expiry_date',
          'conditioning_type',
          'storage_mode',
          'storage_temperature',
          'use_instructions',
          'reheating_instructions',
        ],
      },
      {
        id: 'commercial',
        title: 'Données commerciales',
        fields: ['weight', 'price'],
      },
    ],
    ['commercial_designation', 'expiry_date', 'ingredients'],
  ),
};

export function isTradeCode(value: unknown): value is TradeCode {
  return typeof value === 'string' && value in BUSINESS_PROFILES;
}

/**
 * Resolve presentation metadata. Missing/unknown historical metadata falls back to
 * the original poissonnerie profile; authentication validates new sessions strictly.
 */
export function businessProfileFor(tradeCode: string | null | undefined): BusinessProfile {
  return isTradeCode(tradeCode) ? BUSINESS_PROFILES[tradeCode] : BUSINESS_PROFILES.poissonnerie;
}

const SPECIFIC_FIELD_TRADE = new Map<string, TradeCode>();
for (const code of Object.keys(BUSINESS_PROFILES) as TradeCode[]) {
  const profileFields = BUSINESS_PROFILES[code].fields;
  for (const field of profileFields) {
    const usedBy = (Object.keys(BUSINESS_PROFILES) as TradeCode[]).filter((candidate) =>
      BUSINESS_PROFILES[candidate].fields.includes(field),
    );
    if (usedBy.length === 1) SPECIFIC_FIELD_TRADE.set(field, code);
  }
}

/** Infer a legacy record's profile from unique fields, without dropping unknown data. */
export function inferTradeCodeFromFields(
  fieldNames: Iterable<string>,
  fallback: string | null | undefined = 'poissonnerie',
): TradeCode {
  for (const fieldName of fieldNames) {
    const inferred = SPECIFIC_FIELD_TRADE.get(fieldName);
    if (inferred) return inferred;
  }
  return businessProfileFor(fallback).code;
}
