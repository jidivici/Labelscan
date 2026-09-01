/**
 * fieldCompleteness — the profile score + "product name known" probe powering the home
 * screen's "En cours" cards. Pure, framework-free.
 */

import {
  CANONICAL_FIELD_COUNT,
  canonicalFieldCount,
  filledCountFromInterim,
  filledCountFromRun,
  filledCountFromValues,
  initialHumanReviewValue,
  isProductNameKnownFromInterim,
  isProductNameKnownFromRun,
  normalizeFinalReviewValue,
  NOT_COMMUNICATED_VALUE,
  notCommunicatedSuggestion,
  PRODUCT_NAME_FIELD,
} from '../services/fieldCompleteness';
import type { ExtractionField } from '../types/api';

function field(
  name: string,
  overrides: Partial<ExtractionField> = {},
): ExtractionField {
  return {
    field_name: name,
    value: 'x',
    evidence: [],
    provenance: null,
    source_raw_artifact_id: null,
    validation_status: 'present',
    warnings: null,
    llm_confidence: null,
    ocr_confidence: null,
    combined_confidence: 0.9,
    confidence_band: 'high',
    source: 'llm',
    created_at: '2026-07-05T10:00:00Z',
    ...overrides,
  };
}

describe('fieldCompleteness', () => {
  it('keeps empty review values empty and canonicalizes an explicit NC', () => {
    expect(normalizeFinalReviewValue(null)).toBe('');
    expect(normalizeFinalReviewValue(undefined)).toBe('');
    expect(normalizeFinalReviewValue('   ')).toBe('');
    expect(normalizeFinalReviewValue(' nc ')).toBe(NOT_COMMUNICATED_VALUE);
    expect(normalizeFinalReviewValue('  Cabillaud  ')).toBe('Cabillaud');
  });

  it('keeps a machine absence unconfirmed until the operator explicitly chooses NC', () => {
    const extractedValue: string | null = null;

    const initialDraft = initialHumanReviewValue(extractedValue, 'missing');
    expect(initialDraft).toBe('');
    expect(filledCountFromValues({ commercial_designation: initialDraft })).toBe(0);

    const explicitHumanDecision = NOT_COMMUNICATED_VALUE;
    expect(filledCountFromValues({ commercial_designation: explicitHumanDecision })).toBe(1);
    expect(extractedValue).toBeNull();
  });

  it('ignores a defensive stray value when the machine status is missing', () => {
    expect(initialHumanReviewValue('valeur incohérente', 'missing')).toBe('');
    expect(initialHumanReviewValue(' Cabillaud ', 'present')).toBe('Cabillaud');
    expect(initialHumanReviewValue(' nc ', 'present')).toBe(NOT_COMMUNICATED_VALUE);
  });

  it('proposes NC only after the operator types n or N', () => {
    expect(notCommunicatedSuggestion('n')).toBe(NOT_COMMUNICATED_VALUE);
    expect(notCommunicatedSuggestion(' N ')).toBe(NOT_COMMUNICATED_VALUE);
    expect(notCommunicatedSuggestion('')).toBeNull();
    expect(notCommunicatedSuggestion('na')).toBeNull();
  });
  it('uses the V2 profile-specific field counts', () => {
    expect(CANONICAL_FIELD_COUNT).toBe(16);
    expect(canonicalFieldCount('boucherie')).toBe(21);
    expect(canonicalFieldCount('charcuterie_traiteur')).toBe(21);
  });

  it('filledCountFromRun counts only canonical, present, non-blank fields', () => {
    const fields = [
      field('commercial_designation'),
      field('scientific_name'),
      field('batch_number'),
      field('gtin', { value: '' }), // blank → not filled
      field('price'), // retired field → ignored
      field('not_a_canonical_field'), // outside the closed set → ignored
    ];
    expect(filledCountFromRun(fields)).toBe(3);
  });

  it('does not count questionable machine suggestions before explicit human confirmation', () => {
    const fields = [
      field('commercial_designation', { value: 'Cabillaud ?', validation_status: 'ambiguous' }),
      field('batch_number', { value: 'LOT-?', validation_status: 'unnormalizable' }),
      field('gtin', { value: '1234', validation_status: 'invalid' }),
    ];

    expect(filledCountFromRun(fields)).toBe(0);
    expect(filledCountFromRun(fields, { commercial_designation: 'Cabillaud' })).toBe(1);
    expect(filledCountFromRun(fields, {
      commercial_designation: 'Cabillaud',
      batch_number: 'LOT-42',
      gtin: NOT_COMMUNICATED_VALUE,
    })).toBe(3);
  });

  it('filledCountFromRun is null/empty-safe', () => {
    expect(filledCountFromRun(null)).toBe(0);
    expect(filledCountFromRun([])).toBe(0);
    expect(filledCountFromRun(undefined)).toBe(0);
  });

  it('filledCountFromInterim counts canonical non-blank preview values', () => {
    const interim = {
      commercial_designation: 'Cabillaud',
      FAO_area: '27.8.b.1',
      batch_number: '   ', // blank → not filled
      random_field: 'ignored', // outside the closed set → ignored
    };
    expect(filledCountFromInterim(interim)).toBe(2);
  });

  it('filledCountFromInterim is null/empty-safe', () => {
    expect(filledCountFromInterim(null)).toBe(0);
    expect(filledCountFromInterim({})).toBe(0);
    expect(filledCountFromInterim(undefined)).toBe(0);
  });

  it('isProductNameKnownFromRun is true only with a present, non-blank commercial_designation', () => {
    expect(isProductNameKnownFromRun([field(PRODUCT_NAME_FIELD)])).toBe(true);
    expect(isProductNameKnownFromRun([field(PRODUCT_NAME_FIELD, { value: '' })])).toBe(false);
    expect(isProductNameKnownFromRun([field(PRODUCT_NAME_FIELD, { validation_status: 'missing' })])).toBe(false);
    expect(isProductNameKnownFromRun([field('scientific_name')])).toBe(false);
    expect(isProductNameKnownFromRun(null)).toBe(false);
  });

  it('isProductNameKnownFromInterim mirrors the run probe for the preview map', () => {
    expect(isProductNameKnownFromInterim({ commercial_designation: 'Cabillaud' })).toBe(true);
    expect(isProductNameKnownFromInterim({ commercial_designation: '' })).toBe(false);
    expect(isProductNameKnownFromInterim({ scientific_name: 'Gadus morhua' })).toBe(false);
    expect(isProductNameKnownFromInterim(null)).toBe(false);
  });

  it('filledCountFromValues drives the Review 16/16 save gate on effective drafts', () => {
    const allNames = [
      'commercial_designation', 'scientific_name', 'producer_name', 'reseller_brand',
      'production_method', 'fishing_gear_or_farming_method', 'FAO_area', 'origin_country',
      'health_mark', 'batch_number', 'expiry_date', 'packaging_date',
      'storage_temperature', 'weight', 'allergens', 'gtin',
    ];
    // 15/16 filled (gtin blank) → gate CLOSED.
    const near: Record<string, string> = {};
    for (const n of allNames) near[n] = n === 'gtin' ? '   ' : 'v';
    expect(filledCountFromValues(near)).toBe(15);
    expect(filledCountFromValues(near) === CANONICAL_FIELD_COUNT).toBe(false);

    // Fill the last one → gate OPEN (16/16). Non-canonical keys never count.
    const full = { ...near, gtin: '03400000000000', extra_key: 'ignored' };
    expect(filledCountFromValues(full)).toBe(16);
  });

  it('the review draft (edits) overlays the run count in both directions', () => {
    const fields = [
      field('commercial_designation'),
      field('scientific_name'),
      field('batch_number', { value: null, validation_status: 'missing' }),
    ];
    expect(filledCountFromRun(fields)).toBe(2);
    // Draft fills a missing field → +1 ; draft blanks a filled field → −1.
    expect(filledCountFromRun(fields, { batch_number: 'LOT-42' })).toBe(3);
    expect(filledCountFromRun(fields, { scientific_name: '' })).toBe(1);
    // Both at once — the gauge tracks the operator's session, not the machine values.
    expect(filledCountFromRun(fields, { batch_number: 'LOT-42', scientific_name: ' ' })).toBe(2);
  });

  it('the review draft overlays the interim count and the name probe', () => {
    expect(filledCountFromInterim({ price: '8.95 EUR' }, { weight: '5 kg' })).toBe(1);
    expect(filledCountFromInterim({ price: '8.95 EUR' }, { price: '' })).toBe(0);
    expect(isProductNameKnownFromRun([], { commercial_designation: 'Cabillaud' })).toBe(true);
    expect(
      isProductNameKnownFromRun([field(PRODUCT_NAME_FIELD)], { commercial_designation: '' }),
    ).toBe(false);
    expect(isProductNameKnownFromInterim(null, { commercial_designation: 'Lieu noir' })).toBe(true);
  });

  it('filledCountFromValues is null/empty-safe', () => {
    expect(filledCountFromValues(null)).toBe(0);
    expect(filledCountFromValues({})).toBe(0);
    expect(filledCountFromValues(undefined)).toBe(0);
  });

  it('a run can reach the full /16 when every canonical field is present', () => {
    // Build all 16 canonical fields as present — the score caps at 16.
    const fields = [
      'commercial_designation', 'scientific_name', 'producer_name', 'reseller_brand',
      'production_method', 'fishing_gear_or_farming_method', 'FAO_area', 'origin_country',
      'health_mark', 'batch_number', 'expiry_date', 'packaging_date',
      'storage_temperature', 'weight', 'allergens', 'gtin',
    ].map((n) => field(n));
    expect(filledCountFromRun(fields)).toBe(16);
  });

  it('scores non-fish profiles against their own closed 21-field contract', () => {
    const boucherieFields = [
      'commercial_designation', 'animal_species', 'animal_category', 'cut_name',
      'producer_name', 'reseller_brand', 'origin_country', 'birth_country',
      'rearing_country', 'slaughter_country', 'cutting_country', 'batch_number',
      'health_mark', 'slaughterhouse_approval', 'cutting_plant_approval', 'gtin',
      'packaging_date', 'expiry_date', 'storage_temperature', 'allergens', 'weight',
    ].map((name) => field(name));
    expect(filledCountFromRun(boucherieFields, undefined, 'boucherie')).toBe(21);
    // Fish-only fields do not inflate another trade's score.
    expect(
      filledCountFromRun([...boucherieFields, field('scientific_name')], undefined, 'boucherie'),
    ).toBe(21);
  });
});
