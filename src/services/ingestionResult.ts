/**
 * waitForIngestionResult — resolve one server extraction to its reviewable result.
 *
 * Non-hook core of the former useIngestionResult (workflow v1): the scan QUEUE owns
 * the poll lifecycle now (polls must run while no screen is mounted), so this is a
 * plain async service over pollIngestionUntilReady. It resolves the slow server
 * extraction (OCR + LLM + reconciliation) and returns the run + its fields once the
 * backend reaches a review-ready status.
 *
 * Fast path (audit §1.3): the status response embeds the latest run's fields
 * (`latest_fields`), so the run is built locally — NO second round-trip at the exact
 * moment the operator is waiting. Fallback: fetch the run body (older server).
 */

import { getExtractionRun } from './api';
import { pollIngestionUntilReady } from './ingestionPolling';
import type { ExtractionRunResponse, IngestionStatusResponse } from '../types/api';

export type IngestionResult =
  | { kind: 'ready'; ingestion: IngestionStatusResponse; run: ExtractionRunResponse | null }
  | { kind: 'failed'; status: string; ingestion: IngestionStatusResponse }
  | { kind: 'timeout' } // bounded polling exhausted while still processing
  | { kind: 'aborted' } // cancelled by the caller's AbortSignal
  | { kind: 'error'; code: string; message: string };

export interface WaitForIngestionResultOptions {
  signal?: AbortSignal;
  /**
   * Tier 3 wave 2 — fired with the deterministic preview values (by field name) when
   * the server reports `ocr_done` (LLM still running). Non-authoritative: the final
   * run supersedes them; callers must never persist these.
   */
  onInterim?: (values: Record<string, string>) => void;
  maxDurationMs?: number;
  baseDelayMs?: number;
  /** 0 disables the Tier 4 long-poll (classic ~1 s cadence). */
  longPollSeconds?: number;
}

export async function waitForIngestionResult(
  ingestionId: string,
  options: WaitForIngestionResultOptions = {},
): Promise<IngestionResult> {
  const { signal, onInterim, maxDurationMs, baseDelayMs, longPollSeconds } = options;

  const result = await pollIngestionUntilReady(ingestionId, {
    signal,
    maxDurationMs,
    baseDelayMs,
    longPollSeconds,
    onInterim: onInterim
      ? (ingestion) => {
          const values: Record<string, string> = {};
          for (const f of ingestion.interim_fields ?? []) {
            values[f.field_name] = f.value;
          }
          onInterim(values);
        }
      : undefined,
  });

  if (result.kind !== 'review_ready') return result;

  const runs = result.ingestion.extraction_runs;
  const latest = runs.find((r) => r.is_latest) ?? runs[runs.length - 1];
  let run: ExtractionRunResponse | null = null;
  const embedded = result.ingestion.latest_fields;
  if (latest && embedded) {
    // Fast path: build the run from the embedded fields.
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
      run = await getExtractionRun(latest.run_id, { signal });
    } catch {
      // Status reached review-ready but the run body failed to load — surface the
      // status with a safe "fields unavailable" state rather than spinning forever.
      run = null;
    }
  }
  return { kind: 'ready', ingestion: result.ingestion, run };
}
