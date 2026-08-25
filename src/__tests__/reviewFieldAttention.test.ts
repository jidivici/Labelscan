import { shouldHighlightReviewField } from '../services/reviewFieldAttention';

describe('shouldHighlightReviewField', () => {
  it('highlights empty values regardless of their source status', () => {
    expect(shouldHighlightReviewField('', 'missing', false)).toBe(true);
    expect(shouldHighlightReviewField('   ', 'invalid', true)).toBe(true);
  });

  it('keeps a questionable machine value highlighted until the user changes it', () => {
    expect(shouldHighlightReviewField('03/08/2026', 'invalid', false)).toBe(true);
    expect(shouldHighlightReviewField('03/08/2026', 'invalid', true)).toBe(false);
  });

  it('does not highlight a valid filled value', () => {
    expect(shouldHighlightReviewField('03/08/2026', 'present', false)).toBe(false);
  });
});
