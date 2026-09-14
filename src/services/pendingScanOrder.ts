import type { PendingScan } from './scanQueue';

const STATUS_PRIORITY: Readonly<Record<PendingScan['status'], number>> = {
  ready: 0,
  recapture_required: 1,
  submit_error: 1,
  extract_error: 1,
  submitting: 2,
  extracting: 2,
};

/** Reviews to validate first, errors next, then active/retrying scans; newest first per group. */
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
