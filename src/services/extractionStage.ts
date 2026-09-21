/**
 * Pure timing model for the staged extraction-progress banner (Tier 5 — docs/LATENCY-REVIEW.md §5).
 *
 * The operator should never face a frozen "Analyse…" label: this maps elapsed wait time +
 * the real terminal phase to a coarse stage, so the banner MOVES (Lecture du texte → Analyse
 * → Prêt). The thresholds are deliberate ESTIMATES — they give the wait perceptible movement
 * without any backend support. When the backend later exposes a real "OCR fait" interim state
 * (Tier 3), the SAME banner can bind to actual stage transitions instead of the estimate.
 *
 * Pure + dependency-free so it is unit-tested in isolation (no timers, no React).
 */

export type ExtractionStageKey = 'ocr' | 'llm' | 'ready';

/**
 * Estimated moment OCR hands off to the LLM (ms after the perceived wait starts). Rough
 * order of magnitude for a label read; only used to advance the ESTIMATED banner, never to
 * gate data. Tunable; superseded by a real interim state under Tier 3.
 */
export const OCR_ESTIMATE_MS = 2000;

/**
 * Coarse stage for the progress banner. `ready` (the run landed) always wins; then the
 * REAL backend transit when known — `ocrDone` (Tier 3 `ocr_done` status) pins the stage
 * to 'llm' regardless of the clock; otherwise the elapsed wait picks OCR ("Lecture du
 * texte…") then LLM ("Analyse de l'espèce…") as a timed estimate.
 */
export function extractionStage(
  elapsedMs: number,
  ready: boolean,
  ocrDone: boolean = false,
): ExtractionStageKey {
  if (ready) return 'ready';
  if (ocrDone) return 'llm';
  return elapsedMs < OCR_ESTIMATE_MS ? 'ocr' : 'llm';
}
