import { sortPendingScansNewestFirst } from '../services/pendingScanOrder';

describe('sortPendingScansNewestFirst', () => {
  it('puts the most recently saved scan at the top without mutating the queue', () => {
    const scans = [
      { id: 'old', createdAt: '2026-08-19T08:00:00.000Z' },
      { id: 'new', createdAt: '2026-08-19T10:00:00.000Z' },
      { id: 'middle', createdAt: '2026-08-19T09:00:00.000Z' },
    ];

    expect(sortPendingScansNewestFirst(scans).map((scan) => scan.id)).toEqual([
      'new',
      'middle',
      'old',
    ]);
    expect(scans.map((scan) => scan.id)).toEqual(['old', 'new', 'middle']);
  });
});
