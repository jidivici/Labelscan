import {
  requiresExplicitHumanConfirmation,
  shouldHighlightReviewField,
} from '../services/reviewFieldAttention';

describe('shouldHighlightReviewField', () => {
  it('requires an explicit decision for every questionable machine status', () => {
    expect(requiresExplicitHumanConfirmation('missing')).toBe(true);
    expect(requiresExplicitHumanConfirmation('ambiguous')).toBe(true);
    expect(requiresExplicitHumanConfirmation('unnormalizable')).toBe(true);
    expect(requiresExplicitHumanConfirmation('invalid')).toBe(true);
    expect(requiresExplicitHumanConfirmation('present')).toBe(false);
    expect(requiresExplicitHumanConfirmation('normalized')).toBe(false);
  });

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

  it('never asks the operator to confirm an exact GS1 scan', () => {
    expect(requiresExplicitHumanConfirmation('invalid', 'gs1')).toBe(false);
    expect(shouldHighlightReviewField('93000502900206', 'invalid', false, 'gs1')).toBe(false);
  });
});
