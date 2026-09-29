import { formatFaoDisplay } from '../services/faoDisplay';

describe('FAO presentation preserves traceability', () => {
  it.each([
    ['27', '27 — Atlantique Nord-Est'],
    ['FAO: 27', '27 — Atlantique Nord-Est'],
    ['27.8.b.1', '27.8.b.1 — Atlantique Nord-Est'],
    ['27.VII.d', '27.VII.d — Atlantique Nord-Est'],
  ])('expands %s without dropping any division', (input, expected) => {
    expect(formatFaoDisplay(input)).toBe(expected);
  });
  it.each([
    'Méditerranée', 'Atlantique Nord-Est, sous-zone VIII',
    '27.8.b et autres sous-zones', 'FAO 27 / 37', '12789', 'NC', '',
  ])('keeps words, multiple areas and unknown values intact: %s', (value) => {
    expect(formatFaoDisplay(value)).toBe(value);
  });
  it('preserves an absent value', () => expect(formatFaoDisplay(null)).toBeNull());
});
