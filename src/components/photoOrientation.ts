/** The quarter-turn applied at display time, never a second image transformation. */
export type PhotoBaseRotationDegrees = -90 | 0 | 90;

export function photoDisplayRotation(baseRotationDegrees: PhotoBaseRotationDegrees): string {
  return `${baseRotationDegrees}deg`;
}
