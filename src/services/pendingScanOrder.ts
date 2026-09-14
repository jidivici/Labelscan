import type { PendingScan } from './scanQueue';

const STATUS_PRIORITY: Readonly<Record<PendingScan['status'], number>> = {
  recapture_required: 0,
  submit_error: 0,
  extract_error: 0,
  ready: 1,
  submitting: 2,
  extracting: 2,
};

/** Errors first, reviews to validate next, then active/retrying scans; newest first per group. */
export function sortPendingScansByAttention<
  T extends Pick<PendingScan, 'createdAt' | 'status'>,
>(
  scans: readonly T[],
): T[] {
  return [...scans].sort(
    (a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
      || b.createdAt.localeCompare(a.createdAt),
  );
}
