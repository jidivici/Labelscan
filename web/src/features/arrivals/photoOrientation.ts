export type PhotoRotationDegrees = 0 | 180;
export type PhotoBaseRotationDegrees = -90 | 0;

/** Same authoritative base + manager correction used by cards and viewers. */
export function resolvedPhotoRotationDegrees(
  rotationDegrees: PhotoRotationDegrees = 0,
  baseRotationDegrees: PhotoBaseRotationDegrees = -90,
): number {
  return baseRotationDegrees + rotationDegrees;
}

/** Width and height only need swapping when the final display is quarter-turned. */
export function photoUsesQuarterTurnLayout(
  rotationDegrees: PhotoRotationDegrees = 0,
  baseRotationDegrees: PhotoBaseRotationDegrees = -90,
): boolean {
  return Math.abs(resolvedPhotoRotationDegrees(rotationDegrees, baseRotationDegrees)) === 90;
}
