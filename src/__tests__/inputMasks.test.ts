import {
  maskDate,
  isDateField,
  displayDate,
  parseWeight,
  formatWeight,
  parseTemp,
  formatTemp,
  DATE_FIELDS,
} from '../services/inputMasks';

describe('maskDate — DD/MM/YYYY input mask', () => {
  it('inserts slashes progressively as digits are typed', () => {
    expect(maskDate('')).toBe('');
    expect(maskDate('2')).toBe('2');
    expect(maskDate('20')).toBe('20');
    expect(maskDate('206')).toBe('20/6');
    expect(maskDate('2006')).toBe('20/06');
    expect(maskDate('200620')).toBe('20/06/20');
    expect(maskDate('20062026')).toBe('20/06/2026');
  });

  it('keeps only digits (ignores letters and stray separators)', () => {
    expect(maskDate('20/06/2026')).toBe('20/06/2026');
    expect(maskDate('20-06-2026')).toBe('20/06/2026');
    expect(maskDate('abc20def06')).toBe('20/06');
  });

  it('caps at 8 digits (never overflows DD/MM/YYYY)', () => {
    expect(maskDate('200620269999')).toBe('20/06/2026');
  });

  it('re-masks a shortened string (backspace-friendly)', () => {
    expect(maskDate('20/06/202')).toBe('20/06/202');
    expect(maskDate('20/0')).toBe('20/0');
  });

  it('never invents digits — whitespace/empty stays empty', () => {
    expect(maskDate('   ')).toBe('');
    expect(maskDate('//')).toBe('');
  });
});

describe('isDateField / DATE_FIELDS', () => {
  it('flags only the two date fields', () => {
    expect(isDateField('expiry_date')).toBe(true);
    expect(isDateField('packaging_date')).toBe(true);
    expect(isDateField('weight')).toBe(false);
    expect(isDateField('allergens')).toBe(false);
    expect(isDateField('storage_temperature')).toBe(false);
  });

  it('exposes the set used by the form', () => {
    expect(DATE_FIELDS.has('expiry_date')).toBe(true);
    expect(DATE_FIELDS.size).toBe(2);
  });
});

describe('displayDate — present canonical ISO as DD/MM/YYYY', () => {
  it('converts a full ISO date to DD/MM/YYYY', () => {
    expect(displayDate('2026-06-20')).toBe('20/06/2026');
    expect(displayDate('2027-01-02')).toBe('02/01/2027');
  });

  it('leaves a value already in DD/MM/YYYY unchanged', () => {
    expect(displayDate('20/06/2026')).toBe('20/06/2026');
  });

  it('does not mangle partial / verbatim / empty values', () => {
    expect(displayDate('2026-06')).toBe('2026-06');
    expect(displayDate('Best before 2026-06-20')).toBe('Best before 2026-06-20');
    expect(displayDate('')).toBe('');
  });

  it('round-trips with maskDate for a full date', () => {
    const shown = displayDate('2026-06-20'); // → 20/06/2026
    expect(maskDate(shown)).toBe('20/06/2026');
  });
});

describe('parseWeight / formatWeight', () => {
  it('splits amount + unit, defaulting to kg', () => {
    expect(parseWeight('320 g')).toEqual({ amount: '320', unit: 'g' });
    expect(parseWeight('1.5 kg')).toEqual({ amount: '1.5', unit: 'kg' });
    expect(parseWeight('5')).toEqual({ amount: '5', unit: 'kg' });
    expect(parseWeight('')).toEqual({ amount: '', unit: 'kg' });
  });

  it('accepts a comma decimal', () => {
    expect(parseWeight('1,5 kg')).toEqual({ amount: '1.5', unit: 'kg' });
  });

  it('never turns grams into kg (no magnitude conversion)', () => {
    const { amount, unit } = parseWeight('320 g');
    expect(formatWeight(amount, unit)).toBe('320 g'); // not "320 kg"
  });

  it('rebuilds the string (empty amount → empty)', () => {
    expect(formatWeight('5', 'kg')).toBe('5 kg');
    expect(formatWeight('', 'kg')).toBe('');
  });
});

describe('parseTemp / formatTemp', () => {
  it('parses a range', () => {
    expect(parseTemp('0-4 C')).toEqual({ min: '0', max: '4' });
    expect(parseTemp('0 - 4 °C')).toEqual({ min: '0', max: '4' });
    expect(parseTemp('-2-4 C')).toEqual({ min: '-2', max: '4' });
  });

  it('parses single-bound forms', () => {
    expect(parseTemp('<=4 C')).toEqual({ min: '', max: '4' });
    expect(parseTemp('>=-18 C')).toEqual({ min: '-18', max: '' });
    expect(parseTemp('4 C')).toEqual({ min: '', max: '4' });
    expect(parseTemp('-18 C')).toEqual({ min: '', max: '-18' });
  });

  it('returns empty when there is no number', () => {
    expect(parseTemp('')).toEqual({ min: '', max: '' });
    expect(parseTemp('n/a')).toEqual({ min: '', max: '' });
  });

  it('rebuilds with °C', () => {
    expect(formatTemp('0', '4')).toBe('0 - 4 °C');
    expect(formatTemp('', '4')).toBe('4 °C');
    expect(formatTemp('-18', '')).toBe('-18 °C');
    expect(formatTemp('', '')).toBe('');
  });

  it('round-trips a clean range', () => {
    const { min, max } = parseTemp('0-4 C');
    expect(formatTemp(min, max)).toBe('0 - 4 °C');
  });
});
