/**
 * Calendrier des arrivages — pure day-bucketing helpers (GitHub-contributions style).
 *
 * The home list is scoped to ONE day; the calendar panel is the date selector and
 * each day cell's color intensity encodes how many articles were saved that LOCAL
 * day. All date math lives here (pure + tested); components only render.
 */

import type { Article } from '../types/Article';

/**
 * Local-day key (YYYY-MM-DD) for an ISO timestamp — the operator's wall-clock day,
 * never the UTC day. Missing/invalid input falls back to today (same doctrine as
 * services/dates.ts: never surface a technical failure to the poissonnier).
 */
export function dayKey(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  const m = String(safe.getMonth() + 1).padStart(2, '0');
  const day = String(safe.getDate()).padStart(2, '0');
  return `${safe.getFullYear()}-${m}-${day}`;
}

/** Today's day key — the home list's default scope. */
export function todayKey(): string {
  return dayKey();
}

/** Articles saved per local day, keyed YYYY-MM-DD. Drives the heat map. */
export function countByDay(articles: Article[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const article of articles) {
    const key = dayKey(article.saved_at);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Heat level 0–4 (GitHub-style): 0 = no data; otherwise the day's share of the
 * busiest day mapped to 4 buckets, so the busiest day is always level 4.
 */
export function intensityLevel(count: number, maxCount: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || maxCount <= 0) return 0;
  const level = Math.ceil((Math.min(count, maxCount) / maxCount) * 4);
  return Math.min(4, Math.max(1, level)) as 1 | 2 | 3 | 4;
}

export interface CalendarCell {
  key: string; // YYYY-MM-DD
  day: number; // 1-based day of month
}

/**
 * Fixed 6×7 month grid (42 cells), weeks starting MONDAY (fr). Cells outside the
 * month are null (blank, not adjacent-month days) — the constant grid means month
 * navigation never changes the panel's height. `month` is 0-based.
 */
export function monthGrid(year: number, month: number): (CalendarCell | null)[] {
  const offset = (new Date(year, month, 1).getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthPart = String(month + 1).padStart(2, '0');
  const cells: (CalendarCell | null)[] = [];
  for (let i = 0; i < 42; i++) {
    const day = i - offset + 1;
    cells.push(
      day < 1 || day > daysInMonth
        ? null
        : { key: `${year}-${monthPart}-${String(day).padStart(2, '0')}`, day },
    );
  }
  return cells;
}

/** Panel header title, e.g. "juillet 2026". `month` is 0-based. */
export function monthTitle(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString('fr-FR', {
    month: 'long',
    year: 'numeric',
  });
}

/** Month arithmetic for the ‹ › navigation (handles year boundaries). */
export function addMonths(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** Long French date from a day key, e.g. "3 juillet 2026" — parsed as LOCAL, never UTC. */
export function formatDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** {year, month} of a day key — anchors the calendar on the selected month. */
export function monthOfKey(key: string): { year: number; month: number } {
  const [y, m] = key.split('-').map(Number);
  return { year: y, month: (m ?? 1) - 1 };
}
