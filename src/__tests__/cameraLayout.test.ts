import { cameraLayout } from '../services/cameraLayout';
import { computeFrameCrop } from '../services/frameCrop';

describe('camera layout', () => {
  it('preserves the existing iOS frame and shutter geometry', () => {
    expect(cameraLayout({ platform: 'ios', width: 390, height: 844, insetTop: 47, insetBottom: 34 })).toEqual({
      screenWidth: 390, screenHeight: 844,
      frameLeft: 11.7, frameTop: 103, frameWidth: 366.6, frameHeight: 583,
      bottomTrayHeight: 122,
    });
  });

  it.each([
    // Expected lower edges are those of the previous centered guide.
    { height: 800, insetTop: 24, insetBottom: 48, top: 88, bottom: 644, previewHeight: 732 }, // three-button navigation
    { height: 848, insetTop: 24, insetBottom: 24, top: 88, bottom: 716, previewHeight: 804 }, // gestures / edge-to-edge
    { height: 720, insetTop: 32, insetBottom: 0, top: 96, bottom: 612, previewHeight: 708 }, // display zoom / system bars outside the scene
  ])('extends the Android guide upward while retaining its lower edge: %j', ({ top, bottom, previewHeight, ...bounds }) => {
    const android = cameraLayout({ width: 360, ...bounds, platform: 'android' });
    expect(android.frameTop).toBe(top);
    expect(android.frameTop + android.frameHeight).toBe(bottom);
    expect(android.screenHeight).toBe(previewHeight);
    // The flash button starts 8 points below the safe area and is 44 high.
    expect(android.frameTop - (bounds.insetTop + 8 + 44)).toBe(12);
    expect(android.frameTop + android.frameHeight / 2).toBe(android.screenHeight / 2);
    expect(android.frameLeft + android.frameWidth / 2).toBe(android.screenWidth / 2);
    expect(bottom).toBeLessThanOrEqual(bounds.height - android.bottomTrayHeight - 20);
    expect(android.bottomTrayHeight).toBe(bounds.insetBottom + 88);
  });

  it.each([
    { width: 360, height: 728, insetTop: 24, insetBottom: 24 },
    { width: 360, height: 780, insetTop: 24, insetBottom: 48 },
    { width: 412, height: 891, insetTop: 32, insetBottom: 0 },
  ])('keeps the same crop for both physical landscape orientations: %j', (bounds) => {
    const layout = cameraLayout({ platform: 'android', ...bounds });
    for (const [width, height] of [[4000, 3000], [4624, 3468], [1920, 1080]]) {
      const clockwise = computeFrameCrop(width, height, layout, 'clockwise')!;
      const counterclockwise = computeFrameCrop(width, height, layout, 'counterclockwise')!;
      // Rounding outwards may add one pixel, but can never move the label edge.
      expect(Math.abs(clockwise.originX - counterclockwise.originX)).toBeLessThanOrEqual(1);
      expect(Math.abs(clockwise.originY - counterclockwise.originY)).toBeLessThanOrEqual(1);
      expect(clockwise.width).toBe(counterclockwise.width);
      expect(clockwise.height).toBe(counterclockwise.height);
      expect(Math.abs(clockwise.originX * 2 + clockwise.width - width)).toBeLessThanOrEqual(1);
      expect(Math.abs(clockwise.originY * 2 + clockwise.height - height)).toBeLessThanOrEqual(1);
    }
  });

  it('would lose a different edge after rotation if the enlarged guide used the full scene as its preview', () => {
    const layout = cameraLayout({ platform: 'android', width: 360, height: 728, insetTop: 24, insetBottom: 24 });
    const incorrectPreview = { ...layout, screenHeight: 728 };
    const clockwise = computeFrameCrop(4000, 3000, incorrectPreview, 'clockwise')!;
    const counterclockwise = computeFrameCrop(4000, 3000, incorrectPreview, 'counterclockwise')!;
    expect(Math.abs(clockwise.originX - counterclockwise.originX)).toBeGreaterThan(190);
  });

  it('maps the enlarged guide from the shorter native preview instead of the full Android scene', () => {
    const layout = cameraLayout({ platform: 'android', width: 360, height: 780, insetTop: 24, insetBottom: 24 });
    expect(layout.screenHeight).toBe(736);
    const crop = computeFrameCrop(1080, 2340, layout)!;
    // At 1/3 scale, the source is 780 high and overflows the 736-high
    // preview by 22 on each side. The guide starts at (88 + 22) * 3.
    expect(crop).toEqual({ originX: 32, originY: 330, width: 1016, height: 1680 });
  });

  it('does not force an overflowing minimum guide in a very short Android window', () => {
    const layout = cameraLayout({ platform: 'android', width: 360, height: 220, insetTop: 24, insetBottom: 48 });
    expect(layout.frameHeight).toBe(0);
    expect(computeFrameCrop(1080, 2340, layout)).toBeNull();
  });
});
