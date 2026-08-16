import type { Action, ActionCrop, ActionResize } from 'expo-image-manipulator';

/**
 * Crop and resize the OCR/storage file without changing its capture orientation.
 * Product photos receive their single left rotation only when rendered.
 */
export function captureImageActions(
  crop: ActionCrop['crop'],
  resize: ActionResize['resize'],
): Action[] {
  return [{ crop }, { resize }];
}
