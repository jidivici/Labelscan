import { sortPendingScansByAttention } from '../services/pendingScanOrder';

describe('sortPendingScansByAttention', () => {
  it('puts the most recently saved scan at the top without mutating the queue', () => {
    const scans = [
      { id: 'old', status: 'ready' as const, createdAt: '2026-08-19T08:00:00.000Z' },
      { id: 'new', status: 'ready' as const, createdAt: '2026-08-19T10:00:00.000Z' },
      { id: 'middle', status: 'ready' as const, createdAt: '2026-08-19T09:00:00.000Z' },
    ];

    expect(sortPendingScansByAttention(scans).map((scan) => scan.id)).toEqual([
      'new',
      'middle',
      'old',
    ]);
    expect(scans.map((scan) => scan.id)).toEqual(['old', 'new', 'middle']);
  });

  it('puts reviews before errors, then active retries, with newest first in each group', () => {
    const scans = [
      { id: 'extracting', status: 'extracting' as const, createdAt: '2026-08-19T12:00:00.000Z' },
      { id: 'ready-old', status: 'ready' as const, createdAt: '2026-08-19T08:00:00.000Z' },
      { id: 'error-old', status: 'extract_error' as const, createdAt: '2026-08-19T07:00:00.000Z' },
      { id: 'ready-new', status: 'ready' as const, createdAt: '2026-08-19T11:00:00.000Z' },
      { id: 'recapture', status: 'recapture_required' as const, createdAt: '2026-08-19T10:00:00.000Z' },
      { id: 'submitting', status: 'submitting' as const, createdAt: '2026-08-19T09:00:00.000Z' },
    ];
    expect(sortPendingScansByAttention(scans).map((scan) => scan.id)).toEqual([
      'ready-new', 'ready-old', 'recapture', 'error-old', 'extracting', 'submitting',
    ]);
  });
});
