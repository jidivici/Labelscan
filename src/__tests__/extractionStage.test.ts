import { extractionStage, OCR_ESTIMATE_MS } from '../services/extractionStage';

describe('extractionStage', () => {
  it('starts on the OCR stage at T+0', () => {
    expect(extractionStage(0, false)).toBe('ocr');
  });

  it('stays on OCR right up to the estimate boundary', () => {
    expect(extractionStage(OCR_ESTIMATE_MS - 1, false)).toBe('ocr');
  });

  it('advances to the LLM stage at the estimate boundary', () => {
    expect(extractionStage(OCR_ESTIMATE_MS, false)).toBe('llm');
    expect(extractionStage(5000, false)).toBe('llm');
  });

  it('reports ready as soon as the run has landed, regardless of elapsed time', () => {
    expect(extractionStage(0, true)).toBe('ready');
    expect(extractionStage(99_999, true)).toBe('ready');
  });

  it('pins the stage to llm when the REAL ocr_done transit is known (Tier 3)', () => {
    // even before the estimate boundary — the real signal beats the clock
    expect(extractionStage(0, false, true)).toBe('llm');
    expect(extractionStage(OCR_ESTIMATE_MS - 1, false, true)).toBe('llm');
  });

  it('ready still wins over ocrDone', () => {
    expect(extractionStage(0, true, true)).toBe('ready');
  });
});
