import { physicalQuarterTurnForLandscapeCrop } from '../services/captureOrientation';

describe('physicalQuarterTurnForLandscapeCrop', () => {
  it('turns a still-portrait crop 90 degrees to the left before review', () => {
    expect(physicalQuarterTurnForLandscapeCrop(800, 1600)).toBe(-90);
  });

  it('does not rotate a crop that is already landscape or square', () => {
    expect(physicalQuarterTurnForLandscapeCrop(1600, 800)).toBe(0);
    expect(physicalQuarterTurnForLandscapeCrop(1000, 1000)).toBe(0);
  });
});
