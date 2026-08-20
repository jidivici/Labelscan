import {
  hasExploitableExtraction,
  isExploitableExtractionField,
  RECAPTURE_GUIDANCE,
} from '../services/extractionUsability';
import type { ExtractionField } from '../types/api';

function field(overrides: Partial<ExtractionField> = {}): ExtractionField {
  return {
    field_name: 'commercial_designation',
    value: 'Cabillaud',
    evidence: null,
    provenance: null,
    source_raw_artifact_id: null,
    validation_status: 'present',
    warnings: null,
    llm_confidence: 0.9,
    ocr_confidence: 0.9,
    combined_confidence: 0.9,
    confidence_band: 'high',
    source: 'llm',
    created_at: '2026-08-20T10:00:00Z',
    ...overrides,
  };
}

describe('extraction usability recapture gate', () => {
  it('accepts a usable canonical field', () => {
    expect(hasExploitableExtraction([field()])).toBe(true);
    expect(isExploitableExtractionField(field())).toBe(true);
  });

  it.each(['missing', 'invalid', 'unnormalizable'] as const)(
    'rejects a value carrying the non-usable status %s',
    (validation_status) => {
      expect(hasExploitableExtraction([field({ validation_status })])).toBe(false);
    },
  );

  it('rejects empty, NC-only and off-contract output', () => {
    expect(hasExploitableExtraction([])).toBe(false);
    expect(hasExploitableExtraction([field({ value: '   ' })])).toBe(false);
    expect(hasExploitableExtraction([field({ value: ' nc ' })])).toBe(false);
    expect(
      hasExploitableExtraction([field({ field_name: 'prompt_injected_field' })]),
    ).toBe(false);
  });

  it('uses the authenticated trade contract', () => {
    expect(
      hasExploitableExtraction([field({ field_name: 'animal_species', value: 'Bovin' })], 'boucherie'),
    ).toBe(true);
    expect(
      hasExploitableExtraction([field({ field_name: 'animal_species', value: 'Bovin' })], 'poissonnerie'),
    ).toBe(false);
  });

  it('provides concrete camera guidance instead of allowing blank validation', () => {
    expect(RECAPTURE_GUIDANCE).toContain('Cadrez toute l’étiquette');
    expect(RECAPTURE_GUIDANCE).toContain('reflets');
  });
});
