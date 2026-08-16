import type { Action, ActionCrop, ActionResize } from 'expo-image-manipulator';

/**
 * Prepare the OCR/storage file without changing its capture orientation.
 * Product photos receive their single left rotation only when rendered.
 */
export function captureImageActions(
  crop: ActionCrop['crop'] | null,
  resize: ActionResize['resize'],
): Action[] {
  return crop ? [{ crop }, { resize }] : [{ resize }];
}
