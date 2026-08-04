import {
  maskDate,
  isDateField,
  displayDate,
  parseWeight,
  formatWeight,
  parseTemp,
  formatTemp,
  parsePrice,
  formatPrice,
  toIsoDate,
  validateDate,
  validateTempRange,
  validateWeight,
  DATE_FIELDS,
  isHealthMarkField,
  maskHealthMark,
  validateHealthMark,
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
  it('flags the date fields shared by all three V1 profiles', () => {
    expect(isDateField('expiry_date')).toBe(true);
    expect(isDateField('packaging_date')).toBe(true);
    expect(isDateField('preparation_date')).toBe(true);
    expect(isDateField('weight')).toBe(false);
    expect(isDateField('allergens')).toBe(false);
    expect(isDateField('storage_temperature')).toBe(false);
  });

  it('exposes the set used by the form', () => {
    expect(DATE_FIELDS.has('expiry_date')).toBe(true);
    expect(DATE_FIELDS.size).toBe(3);
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

describe('parsePrice / formatPrice', () => {
  it('splits amount + currency, defaulting to EUR', () => {
    expect(parsePrice('8.95 EUR')).toEqual({ amount: '8.95', currency: 'EUR' });
    expect(parsePrice('8,95 €')).toEqual({ amount: '8.95', currency: 'EUR' });
    expect(parsePrice('12')).toEqual({ amount: '12', currency: 'EUR' });
    expect(parsePrice('')).toEqual({ amount: '', currency: 'EUR' });
  });

  it('keeps an explicit ISO-4217 code', () => {
    expect(parsePrice('9.50 USD')).toEqual({ amount: '9.50', currency: 'USD' });
  });

  it('rebuilds "amount currency" (empty amount → empty)', () => {
    expect(formatPrice('8.95', 'EUR')).toBe('8.95 EUR');
    expect(formatPrice('', 'EUR')).toBe('');
    expect(formatPrice('9,50', 'USD')).toBe('9.50 USD');
  });
});

describe('toIsoDate — DD/MM/YYYY → canonical ISO (inverse of displayDate)', () => {
  it('converts a full DD/MM/YYYY to ISO', () => {
    expect(toIsoDate('20/06/2026')).toBe('2026-06-20');
    expect(toIsoDate('02/01/2027')).toBe('2027-01-02');
  });

  it('passes ISO / partial / verbatim through unchanged', () => {
    expect(toIsoDate('2026-06-20')).toBe('2026-06-20');
    expect(toIsoDate('2026-06')).toBe('2026-06');
    expect(toIsoDate('20/06')).toBe('20/06');
    expect(toIsoDate('')).toBe('');
  });

  it('round-trips with displayDate', () => {
    expect(displayDate(toIsoDate('20/06/2026'))).toBe('20/06/2026');
    expect(toIsoDate(displayDate('2026-06-20'))).toBe('2026-06-20');
  });
});

describe('validateDate — neutral, non-blocking hints', () => {
  it('accepts valid complete dates (DD/MM/YYYY or ISO)', () => {
    expect(validateDate('20/06/2026')).toBeNull();
    expect(validateDate('2026-06-20')).toBeNull();
    expect(validateDate('29/02/2028')).toBeNull(); // leap year
  });

  it('does not flag an empty or still-typing value', () => {
    expect(validateDate('')).toBeNull();
    expect(validateDate('20/0')).toBeNull();
    expect(validateDate('20/06/20')).toBeNull();
  });

  it('flags an implausible complete date', () => {
    expect(validateDate('32/01/2026')).toBe('Jour invalide');
    expect(validateDate('10/13/2026')).toBe('Mois invalide');
    expect(validateDate('29/02/2027')).toBe('Jour invalide'); // 2027 is not a leap year
    expect(validateDate('01/01/1999')).toBe('Année invalide');
  });
});

describe('validateTempRange — min ≤ max, gross outliers', () => {
  it('accepts a valid range or single bound', () => {
    expect(validateTempRange('0', '4')).toBeNull();
    expect(validateTempRange('-18', '')).toBeNull();
    expect(validateTempRange('', '4')).toBeNull();
    expect(validateTempRange('-', '')).toBeNull(); // mid-typing a negative
  });

  it('flags min greater than max', () => {
    expect(validateTempRange('4', '0')).toBe('Min supérieur au max');
  });

  it('flags an implausible temperature', () => {
    expect(validateTempRange('', '400')).toBe('Température inhabituelle');
  });
});

describe('validateWeight — strictly positive', () => {
  it('accepts a positive amount or a still-typing value', () => {
    expect(validateWeight('320')).toBeNull();
    expect(validateWeight('1.5')).toBeNull();
    expect(validateWeight('')).toBeNull();
    expect(validateWeight('.')).toBeNull();
  });

  it('flags zero or negative', () => {
    expect(validateWeight('0')).toBe('Poids invalide');
    expect(validateWeight('-5')).toBe('Poids invalide');
  });
});

describe('isHealthMarkField', () => {
  it('is true only for health_mark', () => {
    expect(isHealthMarkField('health_mark')).toBe(true);
    expect(isHealthMarkField('scientific_name')).toBe(false);
  });
});

describe('maskHealthMark — force uppercase, keystrokes preserved verbatim', () => {
  it('uppercases letters, keeps digits/spaces/dots untouched (real stamp format)', () => {
    expect(maskHealthMark('fr 34.108.504 ce')).toBe('FR 34.108.504 CE');
    expect(maskHealthMark('Fr 12.345.678 Ce')).toBe('FR 12.345.678 CE');
    expect(maskHealthMark('gb bb004')).toBe('GB BB004');
  });

  it('never drops a character (no-fabrication — the mask only cases, never strips)', () => {
    expect(maskHealthMark('es 07-019-003')).toBe('ES 07-019-003');
    expect(maskHealthMark('')).toBe('');
  });
});

describe('validateHealthMark — a real stamp always carries a digit', () => {
  it('is silent while empty or still typing (fewer than 3 chars)', () => {
    expect(validateHealthMark('')).toBeNull();
    expect(validateHealthMark('FR')).toBeNull();
  });

  it('is silent for a plausible stamp (contains a digit)', () => {
    expect(validateHealthMark('FR 34.108.504 CE')).toBeNull();
    expect(validateHealthMark('GB BB004')).toBeNull();
  });

  it('flags a complete-looking value with no digit at all', () => {
    expect(validateHealthMark('FR CE')).toBe('Une estampille contient normalement un numéro');
  });
});
