/**
 * waitForIngestionResult — non-hook core extracted from the former useIngestionResult
 * (workflow v1: the scan queue drives polls, not a screen hook). Mirrors the fast-path
 * / fallback / interim behaviour already proven in ingestionPolling.test.ts, at the
 * level this service adds: building the run from embedded latest_fields, or falling
 * back to getExtractionRun, and forwarding interim values as a plain record.
 */

import { waitForIngestionResult } from '../services/ingestionResult';
import { getExtractionRun, getIngestionStatus } from '../services/api';
import type { ExtractionField, IngestionStatusResponse } from '../types/api';

jest.mock('../services/api', () => ({
  ApiError: class ApiError extends Error {},
  getIngestionStatus: jest.fn(),
  getExtractionRun: jest.fn(),
}));

const mockedGet = getIngestionStatus as jest.MockedFunction<typeof getIngestionStatus>;
const mockedRun = getExtractionRun as jest.MockedFunction<typeof getExtractionRun>;

function statusResponse(overrides: Partial<IngestionStatusResponse> = {}): IngestionStatusResponse {
  return {
    ingestion_id: 'ing-1',
    status: 'extracted' as IngestionStatusResponse['status'],
    barcode_raw: null,
    client_captured_at: null,
    server_received_at: '2026-07-05T10:00:00Z',
    correlation_id: 'corr',
    trace_id: 'trace',
    extraction_runs: [
      {
        run_id: 'run-1',
        attempt_no: 1,
        outcome: 'extracted' as IngestionStatusResponse['status'],
        extractor_version: 'v2',
        llm_model: 'haiku',
        ocr_provider: 'vision',
        created_at: '2026-07-05T10:00:01Z',
        is_latest: true,
      },
    ],
    latest_fields: null,
    interim_fields: null,
    ...overrides,
  };
}

const FIELD: ExtractionField = {
  field_name: 'scientific_name',
  value: 'Gadus morhua',
  evidence: [],
  provenance: null,
  source_raw_artifact_id: null,
  validation_status: 'present',
  warnings: null,
  ocr_confidence: 0.9,
  llm_confidence: 0.9,
  combined_confidence: 0.9,
  confidence_band: 'high',
  source: 'llm',
  created_at: '2026-07-05T10:00:01Z',
};

describe('waitForIngestionResult', () => {
  beforeEach(() => {
    mockedGet.mockReset();
    mockedRun.mockReset();
  });

  it('fast path: builds the run locally from embedded latest_fields (no 2nd round-trip)', async () => {
    mockedGet.mockResolvedValueOnce(statusResponse({ latest_fields: [FIELD] }));

    const result = await waitForIngestionResult('ing-1');

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('expected ready');
    expect(result.run?.run_id).toBe('run-1');
    expect(result.run?.fields).toEqual([FIELD]);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('fallback: fetches the run body when latest_fields is absent (older server)', async () => {
    mockedGet.mockResolvedValueOnce(statusResponse({ latest_fields: null }));
    mockedRun.mockResolvedValueOnce({
      run_id: 'run-1',
      ingestion_id: 'ing-1',
      attempt_no: 1,
      outcome: 'extracted' as IngestionStatusResponse['status'],
      extractor_version: 'v2',
      prompt_version: 'p1',
      ocr_provider: 'vision',
      llm_model: 'haiku',
      ocr_raw_ref: null,
      rule_set_version: 'r1',
      created_at: '2026-07-05T10:00:01Z',
      fields: [FIELD],
    });

    const result = await waitForIngestionResult('ing-1');

    expect(result.kind).toBe('ready');
    expect(mockedRun).toHaveBeenCalledWith('run-1', expect.anything());
  });

  it('forwards Tier 3 wave-2 interim fields as a plain record', async () => {
    const onInterim = jest.fn();
    mockedGet
      .mockResolvedValueOnce(
        statusResponse({
          status: 'ocr_done' as IngestionStatusResponse['status'],
          extraction_runs: [],
          interim_fields: [
            { field_name: 'expiry_date', value: '2026-08-01', source: 'deterministic', created_at: 't' },
          ],
        }),
      )
      .mockResolvedValueOnce(statusResponse({ latest_fields: [FIELD] }));

    await waitForIngestionResult('ing-1', { onInterim });

    expect(onInterim).toHaveBeenCalledWith({ expiry_date: '2026-08-01' });
  });

  it('propagates failed/timeout/error/aborted kinds unchanged', async () => {
    mockedGet.mockResolvedValueOnce(
      statusResponse({ status: 'extraction_failed' as IngestionStatusResponse['status'] }),
    );
    const result = await waitForIngestionResult('ing-1');
    expect(result).toEqual({ kind: 'failed', status: 'extraction_failed' });
  });
});
