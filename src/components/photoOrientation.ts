export type PhotoBaseRotationDegrees = -90 | 0;

export type PhotoDisplayRotation = '-90deg' | '0deg' | '90deg' | '180deg';

/**
 * Resolve the one authoritative display rotation approved by the manager.
 * New captures have a 0° base; historical captures retain their -90° base.
 * The manager correction is always an additional half-turn.
 */
export function photoDisplayRotation(
  baseRotationDegrees: PhotoBaseRotationDegrees,
  halfTurn: boolean,
): PhotoDisplayRotation {
  return `${baseRotationDegrees + (halfTurn ? 180 : 0)}deg` as PhotoDisplayRotation;
}
