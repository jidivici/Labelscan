export type PhysicalRotationAfterCrop = -90 | 0;

/**
 * Normalize the materialized crop to landscape pixels before it is queued.
 * A portrait crop receives the store posture's left quarter-turn; a crop that
 * is already landscape must not be turned into a portrait image again.
 */
export function physicalRotationForLandscapeOutput(
  cropWidth: number,
  cropHeight: number,
): PhysicalRotationAfterCrop {
  return cropHeight > cropWidth ? -90 : 0;
}
