import {
  BUSINESS_PROFILES,
  businessProfileFor,
  inferTradeCodeFromFields,
  isTradeCode,
} from '../services/businessProfiles';
import { FIELD_ORDER, fieldOrderForTrade } from '../services/fieldOrder';
import { fieldLabelFr } from '../services/fieldLabels';

describe('V1 business profiles', () => {
  it.each([
    ['poissonnerie', 17],
    ['boucherie', 22],
    ['charcuterie_traiteur', 22],
  ] as const)('%s exposes one closed, duplicate-free contract of %i fields', (code, count) => {
    const profile = BUSINESS_PROFILES[code];
    expect(profile.version).toBe('1');
    expect(profile.fields).toHaveLength(count);
    expect(new Set(profile.fields).size).toBe(count);
    expect(profile.groups.flatMap((group) => group.fields)).toEqual(profile.fields);
    expect(profile.requiredFields.every((field) => profile.fields.includes(field))).toBe(true);
  });

  it('keeps the historical FIELD_ORDER export as poissonnerie compatibility', () => {
    expect(FIELD_ORDER).toEqual(BUSINESS_PROFILES.poissonnerie.fields);
    expect(fieldOrderForTrade('boucherie')).toEqual(BUSINESS_PROFILES.boucherie.fields);
  });

  it('contains the V1 boucherie and charcuterie-specific review fields', () => {
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
