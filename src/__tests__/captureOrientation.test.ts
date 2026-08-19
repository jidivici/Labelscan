import {
  physicalQuarterTurnForCapturedCrop,
  physicalQuarterTurnForLandscapeCrop,
} from '../services/captureOrientation';

describe('physicalQuarterTurnForLandscapeCrop', () => {
  it('turns a still-portrait crop 90 degrees to the left before review', () => {
    expect(physicalQuarterTurnForLandscapeCrop(800, 1600)).toBe(-90);
  });

  it('does not rotate a crop that is already landscape or square', () => {
    expect(physicalQuarterTurnForLandscapeCrop(1600, 800)).toBe(0);
    expect(physicalQuarterTurnForLandscapeCrop(1000, 1000)).toBe(0);
  });

  it('keeps a portrait preview upright when the camera returns a landscape buffer', () => {
    // Mapping the portrait guide into a landscape sensor buffer produces a
    // landscape crop, but the content still needs the preview transform.
    expect(physicalQuarterTurnForCapturedCrop(
      1600, 800, 4032, 3024, 390, 844, 'counterclockwise',
    )).toBe(-90);
    expect(physicalQuarterTurnForCapturedCrop(
      1600, 800, 4032, 3024, 390, 844, 'clockwise',
    )).toBe(90);
  });
});
