import { isUncertain, UNCERTAIN_BELOW } from '../services/fieldStatus';

const f = (value: string | null, combined_confidence: number, validation_status: string) => ({
  value,
  combined_confidence,
  validation_status,
});

describe('isUncertain', () => {
  it('is false for a confident, present value', () => {
    expect(isUncertain(f('Cabillaud', 0.95, 'present'))).toBe(false);
    expect(isUncertain(f('Cabillaud', 0.7, 'present'))).toBe(false); // exactly 70% is OK
  });

  it('is true below 70% confidence', () => {
    expect(isUncertain(f('Cabillaud', 0.69, 'present'))).toBe(true);
    expect(isUncertain(f('Cabillaud', 0.4, 'present'))).toBe(true);
  });

  it('is true for shaky validation statuses', () => {
    expect(isUncertain(f('xyz', 0.99, 'ambiguous'))).toBe(true);
    expect(isUncertain(f('xyz', 0.99, 'invalid'))).toBe(true);
    expect(isUncertain(f('xyz', 0.99, 'unnormalizable'))).toBe(true);
  });

  it('is false for an empty value (missing, not ambiguous)', () => {
    expect(isUncertain(f(null, 0, 'missing'))).toBe(false);
    expect(isUncertain(f('', 0, 'missing'))).toBe(false);
  });

  it('exposes the 70% threshold', () => {
    expect(UNCERTAIN_BELOW).toBe(0.7);
  });
});
