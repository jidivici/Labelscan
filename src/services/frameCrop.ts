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

  // CameraView fills its bounds with a centered cover fit. Invert that transform
  // to find the exact captured pixels visible inside the on-screen brackets.
  const scale = Math.max(screenWidth / photoWidth, screenHeight / photoHeight);
  const offsetX = (photoWidth * scale - screenWidth) / 2;
  const offsetY = (photoHeight * scale - screenHeight) / 2;
  const left = Math.max(0, Math.min(photoWidth, (frameLeft + offsetX) / scale));
  const top = Math.max(0, Math.min(photoHeight, (frameTop + offsetY) / scale));
  const right = Math.max(left, Math.min(photoWidth, (frameLeft + frameWidth + offsetX) / scale));
  const bottom = Math.max(top, Math.min(photoHeight, (frameTop + frameHeight + offsetY) / scale));

  // Keep every pixel covered by the brackets, without extending outside them.
  const originX = Math.floor(left);
  const originY = Math.floor(top);
  const width = Math.min(photoWidth - originX, Math.ceil(right) - originX);
  const height = Math.min(photoHeight - originY, Math.ceil(bottom) - originY);
  if (width < 1 || height < 1) return null;
  return { originX, originY, width, height };
}

/**
 * Maps the visible placement frame into the captured file's pixels.
 *
 * Android devices may return a landscape sensor buffer while CameraView displays
 * a portrait preview. The virtual 90° mapping below converts the visible frame
 * back to that untouched source buffer, so the crop stays correct either way.
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

  const oriented = cropInPreviewOrientation(photoHeight, photoWidth, geometry);
  if (!oriented) return null;
  return {
    originX: photoWidth - oriented.originY - oriented.height,
    originY: oriented.originX,
    width: oriented.height,
    height: oriented.width,
  };
}
