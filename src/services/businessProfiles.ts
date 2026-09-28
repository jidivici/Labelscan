/**
 * Versioned mobile presentation contracts for the three supported trades.
 *
 * The server remains authoritative for the operator's assignment. These constants
 * only describe how the mobile client renders and reviews the trade code received
 * at login/refresh; the client never chooses or sends a portal with an ingestion.
 */

export type TradeCode = 'poissonnerie' | 'boucherie' | 'charcuterie_traiteur';

export interface FieldGroup {
  id:
    | 'identification'
    | 'fishing-origin'
    | 'meat-origin'
    | 'prepared-composition'
    | 'traceability'
    | 'dates-conservation'
    | 'commercial';
  title: string;
  fields: readonly string[];
}

export interface BusinessProfile {
  code: TradeCode;
  displayName: string;
  version: '2' | '3';
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

const LEGACY_BUSINESS_PROFILES: Readonly<Record<TradeCode, BusinessProfile>> = {
  poissonnerie: profile(
    'poissonnerie',
    'Poissonnerie',
    [
      {
        id: 'identification',
        title: 'Identification du produit',
        fields: ['commercial_designation', 'scientific_name', 'producer_name', 'reseller_brand'],
      },
      {
        id: 'fishing-origin',
        title: 'Provenance et production',
        fields: ['origin_country', 'FAO_area', 'production_method', 'fishing_gear_or_farming_method'],
      },
      {
        id: 'traceability',
        title: 'Traçabilité réglementaire',
        fields: ['batch_number', 'health_mark', 'gtin'],
      },
      {
        id: 'dates-conservation',
        title: 'Dates et conservation',
        fields: ['packaging_date', 'expiry_date', 'storage_temperature', 'allergens'],
      },
      {
        id: 'commercial',
        title: 'Données commerciales',
        fields: ['weight'],
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
        id: 'meat-origin',
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
        id: 'dates-conservation',
        title: 'Dates et conservation',
        fields: ['packaging_date', 'expiry_date', 'storage_temperature', 'allergens'],
      },
      {
        id: 'commercial',
        title: 'Données commerciales',
        fields: ['weight'],
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
        fields: [
          'commercial_designation',
          'product_family',
          'manufacturer_name',
          'producer_name',
          'reseller_brand',
        ],
      },
      {
        id: 'prepared-composition',
        title: 'Composition, allergènes et utilisation',
        fields: ['ingredients', 'additives', 'allergens', 'use_instructions', 'reheating_instructions'],
      },
      {
        id: 'traceability',
        title: 'Traçabilité sanitaire',
        fields: ['batch_number', 'origin_country', 'health_mark', 'gtin'],
      },
      {
        id: 'dates-conservation',
        title: 'Dates, conditionnement et conservation',
        fields: [
          'preparation_date',
          'packaging_date',
          'expiry_date',
          'conditioning_type',
          'storage_mode',
          'storage_temperature',
        ],
      },
      {
        id: 'commercial',
        title: 'Données commerciales',
        fields: ['weight'],
      },
    ],
    ['commercial_designation', 'expiry_date', 'ingredients'],
  ),
};

function currentProfile(legacy: BusinessProfile): BusinessProfile {
  const groups = legacy.groups.map((group) => ({
    ...group,
    fields: group.fields.filter((field) => !['expiry_date', 'gtin'].includes(field)),
  }));
  return {
    ...legacy,
    version: '3',
    groups,
    fields: groups.flatMap((group) => group.fields),
    requiredFields: legacy.requiredFields.filter((field) => field !== 'expiry_date'),
  };
}

export const BUSINESS_PROFILES: Readonly<Record<TradeCode, BusinessProfile>> = {
  poissonnerie: currentProfile(LEGACY_BUSINESS_PROFILES.poissonnerie),
  boucherie: currentProfile(LEGACY_BUSINESS_PROFILES.boucherie),
  charcuterie_traiteur: currentProfile(LEGACY_BUSINESS_PROFILES.charcuterie_traiteur),
};

export function isTradeCode(value: unknown): value is TradeCode {
  return typeof value === 'string' && value in BUSINESS_PROFILES;
}

/**
 * Resolve presentation metadata. Missing/unknown historical metadata falls back to
 * the original poissonnerie profile; authentication validates new sessions strictly.
 */
export function businessProfileFor(tradeCode: string | null | undefined, version?: string | null): BusinessProfile {
  const profiles = version === '1' || version === '2' ? LEGACY_BUSINESS_PROFILES : BUSINESS_PROFILES;
  return isTradeCode(tradeCode) ? profiles[tradeCode] : profiles.poissonnerie;
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
