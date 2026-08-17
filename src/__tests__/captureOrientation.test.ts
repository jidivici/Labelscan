import { physicalQuarterTurnForPortrait } from '../services/captureOrientation';

describe('physicalQuarterTurnForPortrait', () => {
  it('always turns a landscape label 90 degrees to the left', () => {
    expect(physicalQuarterTurnForPortrait(true, 'landscapeLeft')).toBe(-90);
    expect(physicalQuarterTurnForPortrait(true, 'landscapeRight')).toBe(-90);
  });

  it('uses the same left turn when Android exposes no side callback', () => {
    expect(physicalQuarterTurnForPortrait(true, 'portrait')).toBe(-90);
  });

  it('does not rotate a capture that is already portrait', () => {
    expect(physicalQuarterTurnForPortrait(false, 'landscapeLeft')).toBe(0);
  });
});
