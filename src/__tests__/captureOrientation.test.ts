import { physicalQuarterTurnForPortrait } from '../services/captureOrientation';

describe('physicalQuarterTurnForPortrait', () => {
  it('uses the inverted landscape mapping requested for capture output', () => {
    expect(physicalQuarterTurnForPortrait(true, 'landscapeLeft')).toBe(-90);
    expect(physicalQuarterTurnForPortrait(true, 'landscapeRight')).toBe(90);
  });

  it('uses the inverted Android fallback when no side callback is exposed', () => {
    expect(physicalQuarterTurnForPortrait(true, 'portrait')).toBe(90);
  });

  it('does not rotate a capture that is already portrait', () => {
    expect(physicalQuarterTurnForPortrait(false, 'landscapeLeft')).toBe(0);
  });
});
