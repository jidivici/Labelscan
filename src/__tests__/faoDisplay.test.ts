import { formatFaoDisplay } from '../services/faoDisplay';

describe('formatFaoDisplay', () => {
  it('expands a bare area number to "N Nom"', () => {
    expect(formatFaoDisplay('27')).toBe('27 Atlantique Nord-Est');
    expect(formatFaoDisplay('34')).toBe('34 Atlantique Centre-Est');
    expect(formatFaoDisplay('FAO 27')).toBe('27 Atlantique Nord-Est');
  });

  it('renders the sub-zone in Roman from a dotted code', () => {
    expect(formatFaoDisplay('27.5')).toBe('27 Atlantique Nord-Est - Sous zone: (V)');
    expect(formatFaoDisplay('27.8.b.1')).toBe('27 Atlantique Nord-Est - Sous zone: (VIII)');
  });

  it('parses the official worded designation', () => {
    expect(formatFaoDisplay('Atlantique Nord-Est, sous-zone VIII')).toBe(
      '27 Atlantique Nord-Est - Sous zone: (VIII)',
    );
    expect(formatFaoDisplay('Méditerranée')).toBe('37 Méditerranée et mer Noire');
  });

  it('keeps the "et autres sous-zones" qualifier', () => {
    expect(
      formatFaoDisplay('PÊCHE EN ATLANTIQUE NORD-EST, SOUS-ZONE VIII ET AUTRES SOUS-ZONES'),
    ).toBe('27 Atlantique Nord-Est - Sous zone: (VIII et autres)');
  });

  it('keeps the value verbatim when the area is unknown (never invents)', () => {
    expect(formatFaoDisplay('Golfe de Gascogne')).toBe('Golfe de Gascogne');
    expect(formatFaoDisplay('North Sea')).toBe('North Sea');
  });

  it('passes empty/null through for the caller to placeholder', () => {
    expect(formatFaoDisplay('')).toBe('');
    expect(formatFaoDisplay(null)).toBeNull();
  });
});
