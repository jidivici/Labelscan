import {
  BUSINESS_PROFILES,
  businessProfileFor,
  visibleBusinessProfileFor,
  inferTradeCodeFromFields,
  isTradeCode,
} from '../services/businessProfiles';
import { FIELD_ORDER, fieldOrderForTrade } from '../services/fieldOrder';
import { fieldLabelFr } from '../services/fieldLabels';

describe('V3 business profiles', () => {
  it.each([
    ['poissonnerie', 14],
    ['boucherie', 19],
    ['charcuterie_traiteur', 19],
  ] as const)('%s exposes one closed, duplicate-free contract of %i fields', (code, count) => {
    const profile = BUSINESS_PROFILES[code];
    expect(profile.version).toBe('3');
    expect(profile.fields).toHaveLength(count);
    expect(new Set(profile.fields).size).toBe(count);
    expect(profile.groups.flatMap((group) => group.fields)).toEqual(profile.fields);
    expect(profile.requiredFields.every((field) => profile.fields.includes(field))).toBe(true);
    expect(profile.fields).not.toContain('price');
  });

  it('matches the web detail order for poissonnerie', () => {
    expect(BUSINESS_PROFILES.poissonnerie.groups).toEqual([
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
        fields: ['batch_number', 'health_mark'],
      },
      {
        id: 'dates-conservation',
        title: 'Dates et conservation',
        fields: ['packaging_date', 'storage_temperature', 'allergens'],
      },
      {
        id: 'commercial',
        title: 'Données commerciales',
        fields: ['weight'],
      },
    ]);
  });

  it('keeps the historical FIELD_ORDER export as poissonnerie compatibility', () => {
    expect(FIELD_ORDER).toEqual(BUSINESS_PROFILES.poissonnerie.fields);
    expect(fieldOrderForTrade('boucherie')).toEqual(BUSINESS_PROFILES.boucherie.fields);
  });

  it('contains the V3 boucherie and charcuterie-specific review fields', () => {
    expect(BUSINESS_PROFILES.boucherie.fields).toEqual(
      expect.arrayContaining([
        'animal_species',
        'cut_name',
        'birth_country',
        'rearing_country',
        'slaughter_country',
        'slaughterhouse_approval',
        'cutting_plant_approval',
      ]),
    );
    expect(BUSINESS_PROFILES.charcuterie_traiteur.fields).toEqual(
      expect.arrayContaining([
        'product_family',
        'manufacturer_name',
        'preparation_date',
        'conditioning_type',
        'storage_mode',
        'use_instructions',
        'reheating_instructions',
        'ingredients',
        'additives',
      ]),
    );
  });

  it('resolves only supported server trade codes and safely infers historical records', () => {
    expect(isTradeCode('boucherie')).toBe(true);
    expect(isTradeCode('unknown')).toBe(false);
    expect(businessProfileFor('unknown').code).toBe('poissonnerie');
    expect(inferTradeCodeFromFields(['animal_species'])).toBe('boucherie');
    expect(inferTradeCodeFromFields(['ingredients'])).toBe('charcuterie_traiteur');
    expect(inferTradeCodeFromFields(['scientific_name'])).toBe('poissonnerie');
  });

  it('has professional French labels for every profile field', () => {
    for (const profile of Object.values(BUSINESS_PROFILES)) {
      for (const field of profile.fields) expect(fieldLabelFr(field)).not.toBe(field);
    }
  });
});

describe('DLC / GTIN retirement', () => {
  it.each(['poissonnerie', 'boucherie', 'charcuterie_traiteur'])('preserves the historical %s profile', (code) => {
    const current = businessProfileFor(code);
    const historical = businessProfileFor(code, '2');
    expect(current.fields).not.toContain('expiry_date');
    expect(current.fields).not.toContain('gtin');
    expect(current.requiredFields).not.toContain('expiry_date');
    expect(historical.fields).toEqual(expect.arrayContaining(['expiry_date', 'gtin']));
    expect(historical.requiredFields).toContain('expiry_date');
    expect(historical.fields.length).toBe(current.fields.length + 2);
  });
});

describe('visible historical contracts', () => {
  it.each(['1', '2', '3'])('hides retired fields for version %s without changing stored contracts', (version) => {
    for (const trade of ['poissonnerie', 'boucherie', 'charcuterie_traiteur']) {
      const visible = visibleBusinessProfileFor(trade, version);
      expect(visible.fields).not.toContain('gtin');
      expect(visible.fields).not.toContain('expiry_date');
      expect(visible.fields).not.toContain('price');
      expect(visible.requiredFields.every(name => visible.fields.includes(name))).toBe(true);
      if (version !== '3') expect(businessProfileFor(trade, version).fields).toContain('gtin');
    }
  });
});
