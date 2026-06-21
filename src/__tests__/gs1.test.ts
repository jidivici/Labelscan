import { parseGs1, formatGs1WeightKg, gs1FieldValues } from '../services/gs1';

const FNC1 = '\x1d';

describe('GS1 parser (client mirror of server domain/gs1.py)', () => {
  it('parenthesised: GTIN + lot + expiry', () => {
    const r = parseGs1('(01)03700161210047(17)251231(10)LOT123');
    expect(r.gtin).toBe('03700161210047');
    expect(r.lot).toBe('LOT123');
    expect(r.expiryDate).toBe('2025-12-31');
    expect(r.warnings).toEqual([]);
  });

  it('positional with FNC1 separators', () => {
    // 01 (fixed 14) + 10 (variable, FNC1-terminated) + 17 (fixed 6)
    const raw = '0103700161210047' + '10LOT123' + FNC1 + '17251231';
    const r = parseGs1(raw);
    expect(r.gtin).toBe('03700161210047');
    expect(r.lot).toBe('LOT123');
    expect(r.expiryDate).toBe('2025-12-31');
  });

  it('net weight 310x: implied decimals', () => {
    // AI 3103 -> 3 implied decimals; payload 001500 -> 1.500 kg
    const r = parseGs1('(3103)001500');
    expect(r.netWeightKg).toBe(1.5);
    expect(formatGs1WeightKg(r.netWeightKg as number)).toBe('1.5 kg');
  });

  it('day 00 means end of month', () => {
    // AI 17 = 250600 -> June has 30 days -> 2025-06-30
    expect(parseGs1('(17)250600').expiryDate).toBe('2025-06-30');
  });

  it('maps all HACCP dates', () => {
    const r = parseGs1('(11)250101(13)250102(15)250601(17)250630');
    expect(r.productionDate).toBe('2025-01-01');
    expect(r.packagingDate).toBe('2025-01-02');
    expect(r.bestBefore).toBe('2025-06-01');
    expect(r.expiryDate).toBe('2025-06-30');
  });

  it('empty / whitespace input is an empty result', () => {
    expect(parseGs1(null).elements).toEqual({});
    expect(parseGs1(undefined).lot).toBeNull();
    expect(parseGs1('   ').gtin).toBeNull();
  });

  it('invalid GTIN length is warned, not thrown', () => {
    const r = parseGs1('(01)3700161210047'); // 13 digits, not 14
    expect(r.gtin).toBe('3700161210047');
    expect(r.warnings.some((w) => w.includes('GTIN'))).toBe(true);
  });

  it('invalid date is warned and null', () => {
    const r = parseGs1('(17)259999'); // month 99 invalid
    expect(r.expiryDate).toBeNull();
    expect(r.warnings.some((w) => w.includes('17'))).toBe(true);
  });

  it('lot only', () => {
    const r = parseGs1('(10)2548541');
    expect(r.lot).toBe('2548541');
    expect(r.gtin).toBeNull();
    expect(r.expiryDate).toBeNull();
  });

  it('plain EAN-13 yields no AI fields (defensive, no crash)', () => {
    const r = parseGs1('3700161210047');
    expect(r.lot).toBeNull();
    expect(r.gtin).toBeNull();
    expect(r.expiryDate).toBeNull();
  });

  it('formats kg compactly', () => {
    expect(formatGs1WeightKg(0.32)).toBe('0.32 kg');
    expect(formatGs1WeightKg(2)).toBe('2 kg');
  });
});

describe('gs1FieldValues — T+0 field-list prefill', () => {
  it('maps resolved AIs to display strings (dates DD/MM/YYYY, weight "x kg")', () => {
    const v = gs1FieldValues(parseGs1('(01)03700161210047(10)LOT123(17)251231(13)250102(3103)001500'));
    expect(v.batch_number).toBe('LOT123');
    expect(v.gtin).toBe('03700161210047');
    expect(v.expiry_date).toBe('31/12/2025');
    expect(v.packaging_date).toBe('02/01/2025');
    expect(v.weight).toBe('1.5 kg');
  });

  it('falls back to DDM (AI 15) when no DLC (AI 17) is present', () => {
    expect(gs1FieldValues(parseGs1('(15)250601')).expiry_date).toBe('01/06/2025');
  });

  it('leaves unresolved fields undefined (never invents)', () => {
    const v = gs1FieldValues(parseGs1('(10)LOT123'));
    expect(v.batch_number).toBe('LOT123');
    expect(v.gtin).toBeUndefined();
    expect(v.expiry_date).toBeUndefined();
    expect(v.weight).toBeUndefined();
    expect(v.packaging_date).toBeUndefined();
  });
});
