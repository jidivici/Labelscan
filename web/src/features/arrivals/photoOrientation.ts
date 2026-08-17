export type PhotoRotationDegrees = 0 | 180;
export type PhotoBaseRotationDegrees = -90 | 0;

/** Same authoritative base + manager correction used by cards and viewers. */
export function resolvedPhotoRotationDegrees(
  rotationDegrees: PhotoRotationDegrees = 0,
  baseRotationDegrees: PhotoBaseRotationDegrees = -90,
): number {
  return baseRotationDegrees + rotationDegrees;
}
