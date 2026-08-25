/**
 * Versioned mobile presentation contracts for the three supported trades.
 *
 * The server remains authoritative for the operator's assignment. These constants
 * only describe how the SDK-54 client renders and reviews the trade code received
 * at login/refresh; the client never chooses or sends a portal with an ingestion.
 */

export type TradeCode = 'poissonnerie' | 'boucherie' | 'charcuterie_traiteur';

export interface FieldGroup {
  id:
    | 'identification'
    | 'fishing-origin'
    | 'meat-identification'
    | 'meat-origin'
    | 'prepared-product'
    | 'prepared-composition'
    | 'prepared-conservation'
    | 'prepared-traceability'
    | 'traceability'
    | 'conservation'
    | 'prepared-commercial';
  title: string;
  fields: readonly string[];
}

export interface BusinessProfile {
  code: TradeCode;
  displayName: string;
  version: '2';
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
    version: '2',
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
        id: 'identification',
        title: 'Identification du produit',
        fields: ['commercial_designation', 'producer_name', 'reseller_brand', 'gtin'],
      },
      {
        id: 'fishing-origin',
        title: 'Provenance et production',
        fields: ['scientific_name', 'FAO_area', 'production_method', 'fishing_gear_or_farming_method'],
      },
      {
        id: 'traceability',
        title: 'Traçabilité réglementaire',
        fields: ['batch_number', 'origin_country', 'health_mark', 'packaging_date', 'expiry_date'],
      },
      {
        id: 'conservation',
        title: 'Conservation et données commerciales',
        fields: ['storage_temperature', 'allergens', 'weight'],
      },
    ],
    ['scientific_name', 'expiry_date', 'production_method'],
  ),
  boucherie: profile(
    'boucherie',
    'Boucherie',
    [
      {
        id: 'identification',
        title: 'Identification du produit',
        fields: ['commercial_designation', 'producer_name', 'reseller_brand', 'gtin'],
      },
      {
        id: 'meat-identification',
        title: 'Animal et découpe',
        fields: ['animal_species', 'animal_category', 'cut_name'],
      },
      {
        id: 'meat-origin',
        title: 'Élevage, abattage et transformation',
        fields: [
          'birth_country',
          'rearing_country',
          'slaughter_country',
          'cutting_country',
          'slaughterhouse_approval',
          'cutting_plant_approval',
        ],
      },
      {
        id: 'traceability',
        title: 'Traçabilité réglementaire',
        fields: ['batch_number', 'origin_country', 'health_mark', 'packaging_date', 'expiry_date'],
      },
      {
        id: 'conservation',
        title: 'Conservation et données commerciales',
        fields: ['storage_temperature', 'allergens', 'weight'],
      },
    ],
    ['animal_species', 'cut_name', 'expiry_date'],
  ),
  charcuterie_traiteur: profile(
    'charcuterie_traiteur',
    'Charcuterie / Traiteur',
    [
      {
        id: 'identification',
        title: 'Identification du produit',
        fields: ['commercial_designation', 'producer_name', 'reseller_brand', 'gtin'],
      },
      {
        id: 'prepared-product',
        title: 'Famille et fabrication',
        fields: ['product_family', 'manufacturer_name', 'preparation_date'],
      },
      {
        id: 'prepared-composition',
        title: 'Composition, allergènes et utilisation',
        fields: ['ingredients', 'additives', 'allergens', 'use_instructions', 'reheating_instructions'],
      },
      {
        id: 'prepared-conservation',
        title: 'Conditionnement et conservation',
        fields: [
          'conditioning_type',
          'storage_mode',
          'storage_temperature',
          'packaging_date',
          'expiry_date',
        ],
      },
      {
        id: 'prepared-traceability',
        title: 'Traçabilité sanitaire',
        fields: ['batch_number', 'origin_country', 'health_mark'],
      },
      {
        id: 'prepared-commercial',
        title: 'Données commerciales',
        fields: ['weight'],
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
