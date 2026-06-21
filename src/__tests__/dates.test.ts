import { formatDate, formatDateShort } from '../services/dates';

describe('formatDate / formatDateShort', () => {
  it('formats a valid date without ever emitting "Invalid"', () => {
    expect(formatDate('2026-06-20')).not.toMatch(/invalid/i);
    expect(formatDate('2026-06-20')).toMatch(/2026/);
  });

  it('short form is numeric DD/MM/YYYY', () => {
    expect(formatDateShort('2026-06-20')).toBe('20/06/2026');
  });

  it('falls back to today for missing/invalid input (no "Invalid date")', () => {
    // Both invalid and undefined collapse to the same (today) rendering.
    expect(formatDate('not-a-date')).toBe(formatDate(undefined));
    expect(formatDate('')).not.toMatch(/invalid/i);
    expect(formatDateShort('garbage')).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });
});
