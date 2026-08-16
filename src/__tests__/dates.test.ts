import { formatDate, formatDateShort, parseDateValue } from '../services/dates';

describe('formatDate / formatDateShort', () => {
  it('formats a valid date without ever emitting "Invalid"', () => {
    expect(formatDate('2026-06-20')).not.toMatch(/invalid/i);
    expect(formatDate('2026-06-20')).toMatch(/2026/);
  });

  it('short form is numeric DD/MM/YYYY', () => {
    expect(formatDateShort('2026-06-20')).toBe('20/06/2026');
  });

  it('normalizes PostgreSQL timestamps for Hermes', () => {
    expect(parseDateValue('2026-08-14 15:33:10.533187+00')?.toISOString()).toBe(
      '2026-08-14T15:33:10.533Z',
    );
    expect(parseDateValue('2026-08-09 15:33:10.533187+00')?.toISOString()).toBe(
      '2026-08-09T15:33:10.533Z',
    );
  });

  it('renders missing/invalid input as unknown instead of today', () => {
    expect(formatDate('not-a-date')).toBe('Date inconnue');
    expect(formatDate('')).toBe('Date inconnue');
    expect(formatDateShort('garbage')).toBe('Date inconnue');
  });
});
