import type { PreviewQuarterTurn } from './frameCrop';

export type PhysicalQuarterTurn = -90 | 0 | 90;

/**
 * Left quarter-turn baked into a still-portrait crop before it is queued.
 * A crop that is already landscape must not be turned again.
 */
export function physicalQuarterTurnForLandscapeCrop(
  cropWidth: number,
  cropHeight: number,
): Exclude<PhysicalQuarterTurn, 90> {
  return cropHeight > cropWidth ? -90 : 0;
}

/**
 * Chooses the physical rotation for the cropped JPEG, using the same transform
 * as the camera preview when Expo returns a landscape sensor buffer in the
 * portrait-locked app.
 *
 * The crop's aspect ratio alone is not enough: mapping a portrait frame back
 * into a landscape source makes the crop landscape even though its visible
 * content still needs the preview's quarter-turn.  This was the source of
 * incorrectly oriented iPhone captures.
 */
export function physicalQuarterTurnForCapturedCrop(
  cropWidth: number,
  cropHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  screenWidth: number,
  screenHeight: number,
  previewQuarterTurn: PreviewQuarterTurn,
): PhysicalQuarterTurn {
  const portraitPreview = screenHeight > screenWidth;
  const landscapeSource = sourceWidth > sourceHeight;
  if (portraitPreview && landscapeSource) {
    return previewQuarterTurn === 'clockwise' ? 90 : -90;
  }
  return physicalQuarterTurnForLandscapeCrop(cropWidth, cropHeight);
}
