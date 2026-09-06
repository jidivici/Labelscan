/**
 * Backend API types for the upcoming ingestion flow.
 *
 * These MIRROR the documented backend contract (BACKEND-ARCHITECTURE.md,
 * docs/backend/openapi.v1.yaml, extraction.v1) — they are NOT the mobile Article
 * model (src/types/Article.ts), which is unchanged in this batch. Object types
 * are faithful subsets of the server response: extra fields the server returns
 * (e.g. raw_artifacts, audit) are intentionally omitted as the thin client does
 * not consume them.
 */

/** POST /v1/ingestions → 202 Accepted body (server IngestionAcceptedResponse). */
export interface CreateIngestionResponse {
  ingestion_id: string;
  status: string; // 'raw_stored' on accept
  replayed: boolean; // true on an idempotent replay
  correlation_id: string;
}

/** Lifecycle status of an ingestion / outcome of an extraction run — mirror of the
 * server's 12-state machine (ingestion/domain/status.py). */
export type IngestionStatus =
  | 'raw_stored'
  | 'ocr_running'
  | 'ocr_done' // Tier 3 transit: OCR finished, LLM running — interim_fields may be present
  | 'ocr_failed'
  | 'ocr_skipped_garbage' // OCR-quality gate skipped the LLM (illegible image) → review
  | 'extraction_running'
  | 'extracted'
  | 'extraction_failed'
  | 'needs_review'
  | 'confirmed' // reviewer finalized (P3) — a replayed scan of a reviewed label lands here
  | 'rejected'
  | 'halted_missing_context';

/** Summary of one extraction attempt (append-only; the newest is `is_latest`). */
export interface ExtractionRunSummary {
  run_id: string;
  attempt_no: number;
  outcome: IngestionStatus;
  extractor_version: string;
  llm_model: string;
  ocr_provider: string;
  created_at: string;
  is_latest: boolean;
}

/** GET /v1/ingestions/{id} → status projection (subset of server IngestionView). */
export interface IngestionStatusResponse {
  ingestion_id: string;
  status: IngestionStatus;
  barcode_raw: string | null;
  client_captured_at: string | null;
  server_received_at: string;
  correlation_id: string;
  trace_id: string;
  extraction_runs: ExtractionRunSummary[];
  /**
   * The latest run's fields, embedded so the polling client can render Review without a
   * 2nd GET /extraction-runs round-trip (audit §1.3). Null/absent until a run exists.
   */
  latest_fields?: ExtractionField[] | null;
  /**
   * Tier 3 wave 2 — deterministic (regex) preview fields written between OCR and LLM.
   * Present ONLY while no run exists (status ocr_done); the final run supersedes them.
   */
  interim_fields?: InterimField[] | null;
  /** Server-authoritative image-quality decision. */
  recapture_required?: boolean;
  recapture_reason?: string | null;
}

/** One wave-2 preview field (server InterimFieldView). Non-authoritative. */
export interface InterimField {
  field_name: string;
  value: string;
  source: string; // 'deterministic'
  created_at: string;
}

/** Per-field validation status (extraction.v1). */
export type ValidationStatus =
  | 'present'
  | 'missing'
  | 'ambiguous'
  | 'normalized'
  | 'unnormalizable'
  | 'invalid';

/** Combined-confidence band (extraction.v1). */
export type ConfidenceBand = 'low' | 'medium' | 'high';

export interface FieldProvenance {
  raw_artifact_id: string;
  spans: Array<{ page: number; offset_start: number; offset_end: number }>;
}

/** Versioned validation metadata returned by GET /v1/professions. */
export type FieldSpecKind =
  | 'text'
  | 'date'
  | 'decimal_unit'
  | 'temperature_range'
  | 'enum'
  | 'gtin'
  | 'health_mark'
  | 'fao_area'
  | 'country';

export interface FieldSpec {
  kind: FieldSpecKind;
  format: string | null;
  max_length: number;
  enum: string[];
  units: string[];
  nullable: boolean;
}

export type ProfessionCode =
  | 'poissonnerie'
  | 'boucherie'
  | 'charcuterie_traiteur';

/** One server-authoritative profile from GET /v1/professions. */
export interface Profession {
  code: ProfessionCode;
  name: string;
  version: string;
  common_fields: string[];
  specific_fields: string[];
  required_fields: string[];
  field_contract_version: string;
  field_specs: Readonly<Record<string, FieldSpec>>;
}

/** One extracted field with its confidence + validation shape (server FieldView). */
export interface ExtractionField {
  field_name: string;
  value: string | null;
  evidence: string[];
  provenance: FieldProvenance | null;
  source_raw_artifact_id: string | null;
  validation_status: ValidationStatus;
  warnings: string[] | null;
  llm_confidence: number | null;
  ocr_confidence: number | null;
  combined_confidence: number;
  confidence_band: ConfidenceBand;
  source: string;
  created_at: string;
}

/** GET /v1/extraction-runs/{id} → run with fields (subset of server ExtractionRunView). */
export interface ExtractionRunResponse {
  run_id: string;
  ingestion_id: string;
  attempt_no: number;
  outcome: IngestionStatus;
  extractor_version: string;
  prompt_version: string;
  ocr_provider: string;
  llm_model: string;
  ocr_raw_ref: string | null;
  rule_set_version: string;
  created_at: string;
  fields: ExtractionField[];
}
