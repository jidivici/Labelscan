import type { PendingScan } from './scanQueue';

/** Return a new array with the most recently saved pending scan first. */
export function sortPendingScansNewestFirst<T extends Pick<PendingScan, 'createdAt'>>(
  scans: readonly T[],
): T[] {
  return [...scans].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
