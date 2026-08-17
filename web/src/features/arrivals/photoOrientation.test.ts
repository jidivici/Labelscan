import { describe, expect, it } from 'vitest';

import { photoUsesQuarterTurnLayout, resolvedPhotoRotationDegrees } from './photoOrientation';

describe('resolvedPhotoRotationDegrees', () => {
  it('compose la même rotation finale pour toutes les vues', () => {
    expect(resolvedPhotoRotationDegrees(0, 0)).toBe(0);
    expect(resolvedPhotoRotationDegrees(180, 0)).toBe(180);
    expect(resolvedPhotoRotationDegrees(0, -90)).toBe(-90);
    expect(resolvedPhotoRotationDegrees(180, -90)).toBe(90);
  });

  it('échange les dimensions uniquement pour un quart de tour', () => {
    expect(photoUsesQuarterTurnLayout(0, 0)).toBe(false);
    expect(photoUsesQuarterTurnLayout(180, 0)).toBe(false);
    expect(photoUsesQuarterTurnLayout(0, -90)).toBe(true);
    expect(photoUsesQuarterTurnLayout(180, -90)).toBe(true);
  });
});
