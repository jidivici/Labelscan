/**
 * scanStepFromStatus — pure mapping from a PendingScan's workflow status to the
 * home screen's 3-step counter (workflow v1, CLAUDE.md directive §2):
 *   1. Photo envoyée   2. Extraction   3. À valider
 * Sober by design (Clean UI): no percentages, no confidence — a step is done,
 * active, pending, or errored; the active step gets a short present-participle
 * label (never a spinner — PulseDot carries the "live" cue, as in ExtractionProgress).
 */

import type { PendingScanStatus } from './scanQueue';

export type ScanStepStatus = 'done' | 'active' | 'pending' | 'error';

export interface ScanStepsView {
  /** [step 1, step 2, step 3] */
  steps: [ScanStepStatus, ScanStepStatus, ScanStepStatus];
  /** Label for whichever step is currently active or errored. */
  activeLabel: string;
  /** True if the card is tappable (status 'ready' → opens Review). */
  openable: boolean;
}

const LABELS = {
  submitting: 'Envoi de la photo',
  ocr: 'Lecture du texte',
  llm: 'Analyse en cours',
  ready: 'À valider',
  submitError: 'Envoi impossible',
  extractError: 'Analyse impossible',
} as const;

export function scanStepFromStatus(status: PendingScanStatus, ocrDone: boolean): ScanStepsView {
  switch (status) {
    case 'submitting':
      return { steps: ['active', 'pending', 'pending'], activeLabel: LABELS.submitting, openable: false };
    case 'extracting':
      return {
        steps: ['done', 'active', 'pending'],
        activeLabel: ocrDone ? LABELS.llm : LABELS.ocr,
        openable: false,
      };
    case 'ready':
      return { steps: ['done', 'done', 'active'], activeLabel: LABELS.ready, openable: true };
    case 'submit_error':
      return { steps: ['error', 'pending', 'pending'], activeLabel: LABELS.submitError, openable: false };
    case 'extract_error':
      return { steps: ['done', 'error', 'pending'], activeLabel: LABELS.extractError, openable: false };
  }
}
