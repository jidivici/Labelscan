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

});
