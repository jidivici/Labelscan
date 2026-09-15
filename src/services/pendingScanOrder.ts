import type { PendingScan } from './scanQueue';

/**
 * Home-screen priority, in the order the operator can act on it:
 *
 *  1. a failure or a photo to recapture;
 *  2. a review that is genuinely ready to validate (all profile fields filled);
 *  3. work still in progress or a review that still needs completing.
 *
 * `ready` alone cannot mean "ready to validate": its machine extraction may only
 * contain part of the profile. The caller supplies that last bit of presentation
 * state from the fields and any saved human edits.
 */
function attentionPriority<T extends Pick<PendingScan, 'status'>>(
  scan: T,
  isReadyToValidate: (scan: T) => boolean,
): number {
  switch (scan.status) {
    case 'submit_error':
    case 'extract_error':
    case 'recapture_required':
      return 0;
    case 'ready':
      return isReadyToValidate(scan) ? 1 : 2;
    case 'submitting':
    case 'extracting':
      return 2;
  }
}

/**
 * Errors first, then fully completed reviews, then scans still to complete; newest
 * first inside each group. The input queue is never mutated.
 */
export function sortPendingScansByAttention<
  T extends Pick<PendingScan, 'createdAt' | 'status'>,
>(
  scans: readonly T[],
  isReadyToValidate: (scan: T) => boolean = (scan) => scan.status === 'ready',
): T[] {
  return [...scans].sort(
    (a, b) => attentionPriority(a, isReadyToValidate) - attentionPriority(b, isReadyToValidate)
      || b.createdAt.localeCompare(a.createdAt),
  );
}
