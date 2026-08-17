import type { CameraOrientation } from 'expo-camera';

export type PhysicalQuarterTurn = -90 | 0 | 90;

/**
 * Quarter-turn baked into the framed crop so the queued JPEG is readable.
 * The capture posture used in stores requires one fixed clockwise turn
 * so label text is horizontal and readable in review and by OCR.
 */
export function physicalQuarterTurnForPortrait(
  needsQuarterTurn: boolean,
  _orientationAtShutter: CameraOrientation,
): PhysicalQuarterTurn {
  if (!needsQuarterTurn) return 0;
  return 90;
}
