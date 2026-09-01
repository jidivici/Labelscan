import {
  canonicalizeFinalReviewValue,
  isValidGtin,
  validateFinalReviewValues,
} from '../services/finalReviewValidation';

describe('validateFinalReviewValues', () => {
  it('accepts the canonical backend FieldSpec forms and NC', () => {
    expect(validateFinalReviewValues({
      expiry_date: '2026-08-31',
      packaging_date: '2026-08-30',
      production_method: 'wild_caught',
      gtin: '3017620422003',
      weight: '1.250 kg',
      storage_temperature: '0 - 4 °C',
      health_mark: 'FR 34.108.504 CE',
      FAO_area: 'ZONE FAO 27.8 / SOUS-ZONE VIII ET AUTRES SOUS-ZONES',
      origin_country: 'Côte d’Ivoire',
      ingredients: 'Poisson\nsel',
      allergens: 'NC',
    })).toEqual([]);
  });

  it('requires complete real dates and a valid GTIN checksum', () => {
    expect(isValidGtin('3017620422003')).toBe(true);
    expect(isValidGtin('3017620422004')).toBe(false);
    expect(validateFinalReviewValues({
      expiry_date: '31/08/2026',
      packaging_date: '2026-08',
      preparation_date: '2026-02-31',
      gtin: '3017620422004',
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'expiry_date' }),
      expect.objectContaining({ fieldName: 'packaging_date' }),
      expect.objectContaining({ fieldName: 'preparation_date' }),
      expect.objectContaining({ fieldName: 'gtin' }),
    ]));
  });

  it('rejects year zero just like the backend ISO date contract', () => {
    expect(validateFinalReviewValues({ expiry_date: '0000-01-01' })).toEqual([
      expect.objectContaining({ fieldName: 'expiry_date' }),
    ]);
  });

  it('canonicalizes NFC, NC and positive g/kg weights before submission', () => {
    expect(canonicalizeFinalReviewValue('weight', ' 1,25 KG ')).toBe('1.25 kg');
    expect(canonicalizeFinalReviewValue('allergens', ' nc ')).toBe('NC');
    expect(canonicalizeFinalReviewValue('origin_country', 'Cafe\u0301')).toBe('Café');
    expect(canonicalizeFinalReviewValue('production_method', 'Pêche sauvage')).toBe('wild_caught');
    expect(canonicalizeFinalReviewValue('production_method', 'Élevage')).toBe('farmed');
  });

  it('rejects invalid weight and Celsius ranges', () => {
    const errors = validateFinalReviewValues({
      weight: '0 kg',
      storage_temperature: '4 - 0 °C',
      commercial_designation: 'Cabillaud',
    });
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'weight' }),
      expect.objectContaining({ fieldName: 'storage_temperature' }),
    ]));

    expect(validateFinalReviewValues({
      weight: '250 lb',
      storage_temperature: '-101 °C',
    })).toHaveLength(2);
  });

  it('rejects oversized text, control characters and bidi spoofing', () => {
    expect(validateFinalReviewValues({
      ingredients: 'a'.repeat(513),
      allergens: 'Poisson\u0000lait',
      commercial_designation: 'THON\u202e.exe',
      FAO_area: `A${'1'.repeat(120)}`,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'ingredients' }),
      expect.objectContaining({ fieldName: 'allergens' }),
      expect.objectContaining({ fieldName: 'commercial_designation' }),
      expect.objectContaining({ fieldName: 'FAO_area' }),
    ]));
  });

  it('accepts a complete accented FAO designation with regulatory punctuation', () => {
    expect(validateFinalReviewValues({
      FAO_area: "Atlantique Nord-Est (sous-zone VIII), golfe de Gascogne",
    })).toEqual([]);
  });

  it('mirrors the backend country alphabet without standalone combining marks', () => {
    expect(validateFinalReviewValues({ origin_country: 'Côte d’Ivoire' })).toEqual([]);
    expect(validateFinalReviewValues({ origin_country: 'क\u093f' })).toEqual([
      expect.objectContaining({ fieldName: 'origin_country' }),
    ]);
  });

  it('accepts NC for every strict field but never accepts blanks', () => {
    expect(validateFinalReviewValues({
      expiry_date: 'NC',
      production_method: 'nc',
      gtin: 'NC',
      weight: 'NC',
      storage_temperature: 'NC',
    })).toEqual([]);
    expect(validateFinalReviewValues({ weight: '  ' })).toEqual([
      expect.objectContaining({ fieldName: 'weight' }),
    ]);
  });
});
