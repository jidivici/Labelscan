import { formatLatency } from '../services/latencyLog';

describe('formatLatency', () => {
  it('rounds numeric spans to ms and keeps string spans verbatim', () => {
    expect(formatLatency('review', { wait_ms: 1234.7, status: 'extracted' })).toBe(
      '[latency] review wait_ms=1235ms status=extracted',
    );
  });

  it('formats a single upload span', () => {
    expect(formatLatency('capture', { upload_ms: 812.2 })).toBe('[latency] capture upload_ms=812ms');
  });

  it('handles empty spans', () => {
    expect(formatLatency('x', {})).toBe('[latency] x ');
  });
});
