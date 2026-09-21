import { physicalRotationForLandscapeOutput } from '../services/captureOrientation';

describe('physicalRotationForLandscapeOutput', () => {
  it('physically turns a portrait crop 90 degrees left', () => {
    expect(physicalRotationForLandscapeOutput(800, 1600)).toBe(-90);
  });

  it('does not turn a crop that is already landscape', () => {
    expect(physicalRotationForLandscapeOutput(1600, 800)).toBe(0);
  });

  it('keeps a square crop stable', () => {
    expect(physicalRotationForLandscapeOutput(1000, 1000)).toBe(0);
  });
});
