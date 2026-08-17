import { photoDisplayRotation } from '../components/photoOrientation';

describe('photoDisplayRotation', () => {
  it('shows a new physically upright capture without an extra rotation', () => {
    expect(photoDisplayRotation(0, false)).toBe('0deg');
  });

  it('shows the manager-approved half-turn everywhere for a new capture', () => {
    expect(photoDisplayRotation(0, true)).toBe('180deg');
  });

  it('preserves historical base orientation with either manager decision', () => {
    expect(photoDisplayRotation(-90, false)).toBe('-90deg');
    expect(photoDisplayRotation(-90, true)).toBe('90deg');
  });
});
