/**
 * useIngestionResult — owns the foreground extraction wait for one ingestion.
 *
 * This is the second half of the cascade: the caller (ReviewScreen) renders the
 * GS1-decoded fields at T+0, and this hook resolves the slow server extraction
 * (OCR + LLM + reconciliation) in the background, flipping `phase` to 'ready' with
 * the run + its fields once the backend reaches a review-ready status.
 *
 * Previously this logic lived inline in CameraScreen and BLOCKED behind a modal
 * spinner before navigation. Moving it here lets the Review screen mount immediately
 * and fill in progressively. The hook owns its AbortController and aborts the
 * in-flight poll + run fetch on unmount (or when the ingestion id changes).
 */

import { useEffect, useState } from 'react';

import { getExtractionRun } from '../services/api';
import { pollIngestionUntilReady } from '../services/ingestionPolling';
import type { ExtractionRunResponse, IngestionStatusResponse } from '../types/api';

export type IngestionPhase = 'loading' | 'ready' | 'failed' | 'timeout' | 'error';

export interface IngestionResultState {
  phase: IngestionPhase;
  ingestion: IngestionStatusResponse | null;
  run: ExtractionRunResponse | null;
  /** Operator-facing reason, set only for the 'error' phase. */
  message?: string;
}

const LOADING: IngestionResultState = { phase: 'loading', ingestion: null, run: null };

export function useIngestionResult(ingestionId: string | null | undefined): IngestionResultState {
  const [state, setState] = useState<IngestionResultState>(LOADING);

  useEffect(() => {
    if (!ingestionId) return;
    let active = true;
    const controller = new AbortController();
    setState(LOADING);

    (async () => {
      const result = await pollIngestionUntilReady(ingestionId, { signal: controller.signal });
      if (!active) return;

      if (result.kind === 'review_ready') {
        const runs = result.ingestion.extraction_runs;
        const latest = runs.find((r) => r.is_latest) ?? runs[runs.length - 1];
        let run: ExtractionRunResponse | null = null;
        const embedded = result.ingestion.latest_fields;
        if (latest && embedded) {
          // Fast path (audit §1.3): the status response already carries the latest run's
          // fields, so build the run locally — NO second round-trip at the exact moment the
          // operator is waiting on the result.
          run = {
            run_id: latest.run_id,
            ingestion_id: result.ingestion.ingestion_id,
            attempt_no: latest.attempt_no,
            outcome: latest.outcome,
            extractor_version: latest.extractor_version,
            prompt_version: '',
            ocr_provider: latest.ocr_provider,
            llm_model: latest.llm_model,
            ocr_raw_ref: null,
            rule_set_version: '',
            created_at: latest.created_at,
            fields: embedded,
          };
        } else if (latest) {
          // Fallback (older server without latest_fields): fetch the run body.
          try {
            run = await getExtractionRun(latest.run_id, { signal: controller.signal });
          } catch {
            // Status reached review-ready but the run body failed to load — surface the
            // status with a safe "fields unavailable" state rather than spinning forever.
            run = null;
          }
        }
        if (active) setState({ phase: 'ready', ingestion: result.ingestion, run });
        return;
      }

      if (result.kind === 'aborted') return; // unmounted / id changed — keep last state
      if (result.kind === 'failed') {
        setState({ phase: 'failed', ingestion: null, run: null });
      } else if (result.kind === 'timeout') {
        setState({ phase: 'timeout', ingestion: null, run: null });
      } else {
        setState({ phase: 'error', ingestion: null, run: null, message: result.message });
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [ingestionId]);

  return state;
}
