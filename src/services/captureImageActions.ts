import type { Action, ActionCrop, ActionResize } from 'expo-image-manipulator';

/**
 * Crop and resize the landscape OCR/storage file without changing orientation.
 */
export function captureImageActions(
  crop: ActionCrop['crop'],
  resize: ActionResize['resize'],
): Action[] {
  return [{ crop }, { resize }];
}
