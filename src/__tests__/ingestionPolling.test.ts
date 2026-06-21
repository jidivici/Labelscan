import { classifyIngestionStatus } from '../services/ingestionPolling';

describe('classifyIngestionStatus', () => {
  it('classifies "extracted" as review_ready', () => {
    expect(classifyIngestionStatus('extracted')).toBe('review_ready');
  });

  it('classifies "needs_review" as review_ready', () => {
    expect(classifyIngestionStatus('needs_review')).toBe('review_ready');
  });

  it('classifies "extraction_failed" as failed', () => {
    expect(classifyIngestionStatus('extraction_failed')).toBe('failed');
  });

  it('classifies "raw_stored" as processing', () => {
    expect(classifyIngestionStatus('raw_stored')).toBe('processing');
  });

  it('classifies unknown status as unknown', () => {
    expect(classifyIngestionStatus('some_new_status')).toBe('unknown');
  });

  it('classifies empty string as unknown', () => {
    expect(classifyIngestionStatus('')).toBe('unknown');
  });
});
