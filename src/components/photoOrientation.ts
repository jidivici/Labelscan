/** The one and only product-photo rotation, applied at display time (never ingestion). */
export const PHOTO_DISPLAY_ROTATION = '-90deg' as const;

/** Historical files need a quarter turn; new cropped captures are physically upright. */
export type PhotoBaseRotationDegrees = -90 | 0;
