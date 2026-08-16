import { captureImageActions } from '../services/captureImageActions';

describe('captureImageActions', () => {
  it('keeps capture orientation when cropping and resizing', () => {
    const actions = captureImageActions(
      { originX: 10, originY: 20, width: 1200, height: 800 },
      { width: 1200 },
    );

    expect(actions).toEqual([
      { crop: { originX: 10, originY: 20, width: 1200, height: 800 } },
      { resize: { width: 1200 } },
    ]);
    expect(actions.some((action) => 'rotate' in action)).toBe(false);
  });

  it('keeps capture orientation when only resizing', () => {
    const actions = captureImageActions(null, { height: 1600 });

    expect(actions).toEqual([{ resize: { height: 1600 } }]);
    expect(actions.some((action) => 'rotate' in action)).toBe(false);
  });
});
