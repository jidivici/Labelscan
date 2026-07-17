import {
  addMonths,
  countByDay,
  dayKey,
  formatDayKey,
  intensityLevel,
  monthGrid,
  monthOfKey,
  todayKey,
} from '../services/calendar';
import type { Article } from '../types/Article';

function article(saved_at: string): Article {
  return {
    id: `a-${saved_at}`,
    source: 'backend_extraction',
    ingestion_id: 'ing-1',
    extraction_run_id: null,
    captured_at: saved_at,
    photo_uri: null,
    barcode_raw: null,
    ingestion_status: 'extracted',
    fields: [],
    saved_at,
    saved_by: null,
  };
}

describe('dayKey / todayKey', () => {
  it('buckets an ISO timestamp on its LOCAL calendar day', () => {
    // No timezone suffix → parsed as local time, so the key is unambiguous.
    expect(dayKey('2026-07-03T10:30:00')).toBe('2026-07-03');
    expect(dayKey('2026-07-03T23:59:59')).toBe('2026-07-03');
  });

  it('zero-pads month and day', () => {
    expect(dayKey('2026-01-05T08:00:00')).toBe('2026-01-05');
  });

  it('falls back to today for missing/invalid input (never a technical failure)', () => {
    expect(dayKey(null)).toBe(todayKey());
    expect(dayKey('not-a-date')).toBe(todayKey());
    expect(todayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('countByDay', () => {
  it('counts saved articles per local day', () => {
    const counts = countByDay([
      article('2026-07-03T09:00:00'),
      article('2026-07-03T15:00:00'),
      article('2026-07-06T08:00:00'),
    ]);
    expect(counts['2026-07-03']).toBe(2);
    expect(counts['2026-07-06']).toBe(1);
    expect(counts['2026-07-04']).toBeUndefined();
  });

  it('is empty for no articles', () => {
    expect(countByDay([])).toEqual({});
  });
});

describe('intensityLevel', () => {
  it('is 0 for no data (and for a degenerate max)', () => {
    expect(intensityLevel(0, 8)).toBe(0);
    expect(intensityLevel(3, 0)).toBe(0);
  });

  it('maps the share of the busiest day onto 4 buckets, busiest = 4', () => {
    expect(intensityLevel(1, 8)).toBe(1);
    expect(intensityLevel(2, 8)).toBe(1);
    expect(intensityLevel(3, 8)).toBe(2);
    expect(intensityLevel(4, 8)).toBe(2);
    expect(intensityLevel(6, 8)).toBe(3);
    expect(intensityLevel(8, 8)).toBe(4);
  });

  it('a lone day of data reads as the max level, and counts above max clamp', () => {
    expect(intensityLevel(1, 1)).toBe(4);
    expect(intensityLevel(12, 8)).toBe(4);
  });
});

describe('monthGrid', () => {
  it('is a fixed 42-cell grid, weeks starting Monday (July 2026 starts Wednesday)', () => {
    const grid = monthGrid(2026, 6); // July 2026
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBeNull();
    expect(grid[1]).toBeNull();
    expect(grid[2]).toEqual({ key: '2026-07-01', day: 1 });
    expect(grid[32]).toEqual({ key: '2026-07-31', day: 31 });
    expect(grid[33]).toBeNull();
  });

  it('handles a month starting on Sunday (offset 6 — February 2026)', () => {
    const grid = monthGrid(2026, 1);
    expect(grid[5]).toBeNull();
    expect(grid[6]).toEqual({ key: '2026-02-01', day: 1 });
    expect(grid[33]).toEqual({ key: '2026-02-28', day: 28 });
    expect(grid[34]).toBeNull();
  });
});

describe('month navigation + labels', () => {
  it('addMonths crosses year boundaries both ways', () => {
    expect(addMonths(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(addMonths(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(addMonths(2026, 6, 0)).toEqual({ year: 2026, month: 6 });
  });

  it('monthOfKey anchors the calendar on the selected month', () => {
    expect(monthOfKey('2026-07-03')).toEqual({ year: 2026, month: 6 });
  });

  it('formatDayKey renders the LOCAL day (no UTC drift), French long form', () => {
    expect(formatDayKey('2026-07-03')).toBe('3 juillet 2026');
  });
});
