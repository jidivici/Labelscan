import { computeFrameCrop } from '../services/frameCrop';

const geometry = {
  screenWidth: 500,
  screenHeight: 1000,
  frameLeft: 50,
  frameTop: 100,
  frameWidth: 400,
  frameHeight: 800,
};

describe('computeFrameCrop', () => {
  it('maps the exact visible frame when the photo and preview share orientation', () => {
    expect(computeFrameCrop(1000, 2000, geometry)).toEqual({
      originX: 100,
      originY: 200,
      width: 800,
      height: 1600,
    });
  });

  it('maps a portrait preview into a transposed landscape capture buffer', () => {
    expect(computeFrameCrop(2000, 1000, geometry)).toEqual({
      originX: 200,
      originY: 100,
      width: 1600,
      height: 800,
    });
  });

  it('uses the opposite source mapping when the landscape preview is clockwise', () => {
    expect(computeFrameCrop(2000, 1000, {
      ...geometry,
      frameLeft: 20,
      frameTop: 300,
      frameHeight: 500,
    }, 'clockwise')).toEqual({
      originX: 600,
      originY: 160,
      width: 1000,
      height: 800,
    });
  });

  it('inverts the centered cover overflow', () => {
    expect(computeFrameCrop(1200, 2000, geometry)).toEqual({
      originX: 200,
      originY: 200,
      width: 800,
      height: 1600,
    });
  });

  it('rejects invalid geometry', () => {
    expect(computeFrameCrop(0, 2000, geometry)).toBeNull();
    expect(computeFrameCrop(1000, 2000, { ...geometry, frameWidth: 0 })).toBeNull();
  });
});
