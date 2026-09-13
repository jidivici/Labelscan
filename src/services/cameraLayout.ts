import type { FrameGeometry } from './frameCrop';

interface CameraLayoutInput {
  platform: string;
  width: number;
  height: number;
  insetTop: number;
  insetBottom: number;
}

/** The overlay and crop must share the exact bounds of the live preview. */
export function cameraLayout({
  platform, width, height, insetTop, insetBottom,
}: CameraLayoutInput): FrameGeometry & { bottomTrayHeight: number } {
  const bottomTrayHeight = insetBottom + 88;
  const frameLeft = width * 0.03;
  const isAndroid = platform === 'android';
  const androidBottomMargin = Math.max(insetTop + 56, bottomTrayHeight + 20);
  // The upper controls end at insetTop + 8 + 44. Leave 12 points below them,
  // extending only the top of the Android guide; retain its lower edge.
  const frameTop = isAndroid
    ? Math.min(height / 2, androidBottomMargin, insetTop + 64)
    : insetTop + 56;
  const availableHeight = isAndroid
    ? height - frameTop - androidBottomMargin
    : height - frameTop - bottomTrayHeight - 36;
  const frameHeight = isAndroid ? Math.max(0, availableHeight) : Math.max(180, availableHeight);
  // CameraX can rotate captures independently of the portrait UI. Shorten the
  // actual preview behind the shutter so the enlarged guide remains centered
  // in it, keeping both quarter-turns (and a half-turn) equivalent for cropping.
  // screenHeight describes this native preview, not the full screen scene.
  const previewHeight = isAndroid ? frameTop * 2 + frameHeight : height;
  return {
    screenWidth: width,
    screenHeight: previewHeight,
    frameLeft,
    frameTop,
    frameWidth: width - frameLeft * 2,
    frameHeight,
    bottomTrayHeight,
  };
}
