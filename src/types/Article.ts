/**
 * Local Article model — backend-extraction only.
 *
 * There is no legacy on-device-OCR Article shape anymore; articles are saved from
 * backend-reviewed extraction runs (ReviewScreen backend mode). Structured fields
 * are preserved verbatim — never reduced to a single text blob.
 */

import type { ConfidenceBand, ExtractionRunResponse, ValidationStatus } from './api';

/** Compact projection of one backend-extracted field, persisted for display. */
export interface ArticleField {
  field_name: string;
  value: string | null;
  combined_confidence: number;
  confidence_band: ConfidenceBand;
  validation_status: ValidationStatus;
  /**
   * True when a human corrected this value at review time (missing or low-confidence
   * field edited before saving). The original machine output is retained verbatim on
   * `Article.raw_extraction_run` (never overwritten — immutability doctrine, ADR-0003).
   * NOTE: this is a LOCAL correction on the saved article; the server-side human
   * override (`PATCH /v1/ingestions/{id}/fields/{name}`, source='human', new run) is
   * documented in API-CONTRACTS but not yet implemented on the backend.
   */
  edited?: boolean;
}

export interface Article {
  id: string; // local uuid
  source: 'backend_extraction';
  ingestion_id: string;
  extraction_run_id: string | null;
  captured_at: string; // ISO 8601
  photo_uri: string | null; // permanent local path, when a photo was kept
  /** Half-turn approved by the reviewer; the immutable OCR source is unchanged. */
  photo_rotation_degrees?: 0 | 180;
  /** Historical raw photos need -90° on display; new crops are already upright. */
  photo_base_rotation_degrees?: -90 | 0;
  barcode_raw: string | null;
  ingestion_status: string; // e.g. 'extracted' | 'needs_review'
  fields: ArticleField[];
  saved_at: string; // ISO 8601
  saved_by: string | null; // signed-in user who saved this record; null if unknown
  /** Server snapshot metadata; optional so historical local records remain readable. */
  business_portal_id?: string | null;
  trade_code?: string;
  trade_profile_version?: string;
  raw_extraction_run?: ExtractionRunResponse | null; // full payload, for debugging
}
