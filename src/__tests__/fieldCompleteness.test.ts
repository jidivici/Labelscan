/**
 * fieldCompleteness — the /17 score + "product name known" probe powering the home
 * screen's "En cours" cards. Pure, framework-free.
 */

import {
  CANONICAL_FIELD_COUNT,
  filledCountFromInterim,
  filledCountFromRun,
  filledCountFromValues,
  isProductNameKnownFromInterim,
  isProductNameKnownFromRun,
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
    evidence: null,
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
  it('CANONICAL_FIELD_COUNT is 17 (the closed LLM field set)', () => {
    expect(CANONICAL_FIELD_COUNT).toBe(17);
  });

  it('filledCountFromRun counts only canonical, present, non-blank fields', () => {
    const fields = [
      field('commercial_designation'),
      field('scientific_name'),
      field('batch_number'),
      field('gtin', { value: '' }), // blank → not filled
      field('price', { validation_status: 'missing' }), // missing → not filled
      field('not_a_canonical_field'), // outside the closed set → ignored
    ];
    expect(filledCountFromRun(fields)).toBe(3);
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

  it('filledCountFromValues drives the Review 17/17 save gate on effective drafts', () => {
    const allNames = [
      'commercial_designation', 'scientific_name', 'producer_name', 'reseller_brand',
      'production_method', 'fishing_gear_or_farming_method', 'FAO_area', 'origin_country',
      'health_mark', 'batch_number', 'expiry_date', 'packaging_date',
      'storage_temperature', 'weight', 'allergens', 'price', 'gtin',
    ];
    // 16/17 filled (gtin blank) → gate CLOSED.
    const near: Record<string, string> = {};
    for (const n of allNames) near[n] = n === 'gtin' ? '   ' : 'v';
    expect(filledCountFromValues(near)).toBe(16);
    expect(filledCountFromValues(near) === CANONICAL_FIELD_COUNT).toBe(false);

    // Fill the last one → gate OPEN (17/17). Non-canonical keys never count.
    const full = { ...near, gtin: '03400000000000', extra_key: 'ignored' };
    expect(filledCountFromValues(full)).toBe(17);
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
    expect(filledCountFromInterim({ price: '8.95 EUR' }, { weight: '5 kg' })).toBe(2);
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

  it('a run can reach the full /17 when every canonical field is present', () => {
    // Build all 17 canonical fields as present — the score caps at 17.
    const fields = [
      'commercial_designation', 'scientific_name', 'producer_name', 'reseller_brand',
      'production_method', 'fishing_gear_or_farming_method', 'FAO_area', 'origin_country',
      'health_mark', 'batch_number', 'expiry_date', 'packaging_date',
      'storage_temperature', 'weight', 'allergens', 'price', 'gtin',
    ].map((n) => field(n));
    expect(filledCountFromRun(fields)).toBe(17);
  });
});
