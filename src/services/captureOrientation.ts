import type { CameraOrientation } from 'expo-camera';

export type PhysicalQuarterTurn = -90 | 0 | 90;

/**
 * Quarter-turn baked into a landscape crop so the queued JPEG is portrait.
 * Android currently falls back to the non-left branch because Expo Camera does
 * not expose its physical orientation callback there.
 */
export function physicalQuarterTurnForPortrait(
  needsQuarterTurn: boolean,
  orientationAtShutter: CameraOrientation,
): PhysicalQuarterTurn {
  if (!needsQuarterTurn) return 0;
  return orientationAtShutter === 'landscapeLeft' ? -90 : 90;
}
