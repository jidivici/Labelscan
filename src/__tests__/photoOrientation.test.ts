import { photoDisplayRotation } from '../components/photoOrientation';

describe('photoDisplayRotation', () => {
  it('preserves the direction captured for either landscape grip', () => {
    expect(photoDisplayRotation(-90)).toBe('-90deg');
    expect(photoDisplayRotation(90)).toBe('90deg');
  });
});
