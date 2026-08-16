export interface FrameGeometry {
  screenWidth: number;
  screenHeight: number;
  frameLeft: number;
  frameTop: number;
  frameWidth: number;
  frameHeight: number;
}

export interface CropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

function cropInPreviewOrientation(
  photoWidth: number,
  photoHeight: number,
  geometry: FrameGeometry,
): CropRect | null {
  const { screenWidth, screenHeight, frameLeft, frameTop, frameWidth, frameHeight } = geometry;
  if (
    photoWidth <= 0 || photoHeight <= 0 || screenWidth <= 0 || screenHeight <= 0
    || frameWidth <= 0 || frameHeight <= 0
  ) return null;

  // CameraView fills its bounds like a centered `cover` image. Invert that fit to
  // recover the exact photo pixels visible inside the on-screen frame.
  const scale = Math.max(screenWidth / photoWidth, screenHeight / photoHeight);
  const offsetX = (photoWidth * scale - screenWidth) / 2;
  const offsetY = (photoHeight * scale - screenHeight) / 2;
  const left = Math.max(0, Math.min(photoWidth, (frameLeft + offsetX) / scale));
  const top = Math.max(0, Math.min(photoHeight, (frameTop + offsetY) / scale));
  const right = Math.max(left, Math.min(photoWidth, (frameLeft + frameWidth + offsetX) / scale));
  const bottom = Math.max(top, Math.min(photoHeight, (frameTop + frameHeight + offsetY) / scale));

  // Floor the near edge and ceil the far edge: every pixel visible within the
  // brackets is retained, without adding an arbitrary margin outside the frame.
  const originX = Math.floor(left);
  const originY = Math.floor(top);
  const width = Math.min(photoWidth - originX, Math.ceil(right) - originX);
  const height = Math.min(photoHeight - originY, Math.ceil(bottom) - originY);
  if (width < 1 || height < 1) return null;
  return { originX, originY, width, height };
}

/**
 * Map the visible camera frame to captured-file coordinates.
 *
 * Some devices return a landscape buffer for a portrait preview. Product photos
 * are displayed with the project's canonical left quarter-turn, so we perform the
 * same virtual turn for the mapping, then convert the crop back to the untouched
 * source buffer. This preserves the existing OCR/display orientation while making
 * the crop match the brackets on both orientation paths.
 */
export function computeFrameCrop(
  photoWidth: number,
  photoHeight: number,
  geometry: FrameGeometry,
): CropRect | null {
  const screenIsLandscape = geometry.screenWidth > geometry.screenHeight;
  const photoIsLandscape = photoWidth > photoHeight;
  if (screenIsLandscape === photoIsLandscape) {
    return cropInPreviewOrientation(photoWidth, photoHeight, geometry);
  }

  // Virtual 90° counter-clockwise rotation: oriented width/height are swapped.
  const oriented = cropInPreviewOrientation(photoHeight, photoWidth, geometry);
  if (!oriented) return null;
  return {
    originX: photoWidth - oriented.originY - oriented.height,
    originY: oriented.originX,
    width: oriented.height,
    height: oriented.width,
  };
}
