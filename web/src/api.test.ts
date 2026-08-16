import { describe, expect, it } from 'vitest';

import { arrivalImagePath } from './api';

describe('arrivalImagePath', () => {
  it('keeps the immutable source as the default', () => {
    expect(arrivalImagePath('batch/1')).toBe('/v1/arrivals/batch%2F1/image');
  });

  it('requests a compact image for collection views', () => {
    expect(arrivalImagePath('batch-1', 'thumbnail')).toBe(
      '/v1/arrivals/batch-1/image?variant=thumbnail',
    );
  });
});
