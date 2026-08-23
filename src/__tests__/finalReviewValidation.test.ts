import { validateFinalReviewValues } from '../services/finalReviewValidation';

describe('validateFinalReviewValues', () => {
  it('accepts canonical dates, controlled values, valid GTIN and NC', () => {
    expect(validateFinalReviewValues({
      expiry_date: '2026-08-31',
      packaging_date: '2026-08',
      production_method: 'wild_caught',
      gtin: '3017620422003',
      price: 'NC',
    })).toEqual([]);
  });

  it('rejects values that the backend would answer with HTTP 400', () => {
    expect(validateFinalReviewValues({
      expiry_date: '31/08/26',
      packaging_date: '2026-02-31',
      production_method: 'Pêche sauvage',
      gtin: '1234567',
      price: '  ',
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: 'expiry_date' }),
      expect.objectContaining({ fieldName: 'packaging_date' }),
      expect.objectContaining({ fieldName: 'production_method' }),
      expect.objectContaining({ fieldName: 'gtin' }),
      expect.objectContaining({ fieldName: 'price' }),
    ]));
  });

  it('accepts NC for every strict field', () => {
    expect(validateFinalReviewValues({
      expiry_date: 'NC',
      production_method: 'nc',
      gtin: 'NC',
    })).toEqual([]);
  });
});
