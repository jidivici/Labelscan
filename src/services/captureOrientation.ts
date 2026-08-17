export type PhysicalQuarterTurn = -90 | 0;

/**
 * Left quarter-turn baked into a still-portrait crop before it is queued.
 * A crop that is already landscape must not be turned again.
 */
export function physicalQuarterTurnForLandscapeCrop(
  cropWidth: number,
  cropHeight: number,
): PhysicalQuarterTurn {
  return cropHeight > cropWidth ? -90 : 0;
}
