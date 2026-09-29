import { canonicalizeFinalReviewValue, validateFinalReviewValues } from '../services/finalReviewValidation';

// Exercise the save boundary, including calendar validity and text-month precision.
describe('flexible label dates at save time', () => {
  it.each([
    ['20/JUN/26', '2026-06-20'], ['Jun 20, 2026', '2026-06-20'],
    ['1er février 2026', '2026-02-01'], ['July 1st, 26', '2026-07-01'],
    ['2026/06/20', '2026-06-20'], ['20.06.26', '2026-06-20'],
    ['06/20/2026', '2026-06-20'], ['20260620', '2026-06-20'],
    ['20062026', '2026-06-20'], ['29/02/24', '2024-02-29'],
  ])('saves %s as %s', (input, expected) => {
    expect(canonicalizeFinalReviewValue('packaging_date', input)).toBe(expected);
    expect(validateFinalReviewValues({ packaging_date: input })).toEqual([]);
  });
  it.each(['1800-01-01', '2200-01-01', '29/02/2026', '31 Apr 26', '20 Jungle 2026', 'June 2026', '2026-06', '260620'])('requires review for %s', (input) => {
    expect(canonicalizeFinalReviewValue('packaging_date', input)).toBe(input);
    expect(validateFinalReviewValues({ packaging_date: input })).toHaveLength(1);
  });
  it('accepts printed FAO separators without dropping divisions', () => {
    const FAO_area = 'FAO: 27.8.b.1; 27.8.c';
    expect(validateFinalReviewValues({ FAO_area })).toEqual([]);
    expect(canonicalizeFinalReviewValue('FAO_area', FAO_area)).toBe(FAO_area);
  });
});

it('keeps multiline FAO information when saving', () => {
  expect(canonicalizeFinalReviewValue('FAO_area', 'FAO: 27.8.b.1;\n27.8.c')).toBe('FAO: 27.8.b.1; 27.8.c');
});
