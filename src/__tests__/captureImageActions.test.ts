import { captureImageActions } from '../services/captureImageActions';

describe('captureImageActions', () => {
  it('rotates a landscape crop left before resizing it for OCR', () => {
    const actions = captureImageActions(
      { originX: 10, originY: 20, width: 1200, height: 800 },
      { height: 1200 },
      -90,
    );

    expect(actions).toEqual([
      { crop: { originX: 10, originY: 20, width: 1200, height: 800 } },
      { rotate: -90 },
      { resize: { height: 1200 } },
    ]);
  });
});
