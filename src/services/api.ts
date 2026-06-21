/**
 * Backend API client.
 *
 *  - configurable base URL (src/config.ts)
 *  - typed JSON requests (apiRequest) + multipart/form-data uploads (apiUpload)
 *  - AbortController timeout (covers fetch + body read)
 *  - safe, typed error shape (ApiError) parsed from RFC 9457 problem+json
 *  - request identifiers: X-Correlation-Id (always) and Idempotency-Key (writes),
 *    generated when not supplied, overridable by callers/tests
 *  - JWT auth: attaches `Authorization: Bearer <token>` from secure storage
 *    (services/authStorage); a 401 on an authenticated request clears the token
 *    and signals sign-out. The login call opts out via `skipAuth`.
 *
 * No secrets, no OCR logic.
 */

import 'react-native-get-random-values'; // crypto polyfill for uuid (also imported in App.tsx)
import { v4 as uuidv4 } from 'uuid';

import { API_BASE_URL } from '../config';
import { clearToken, emitUnauthenticated, getToken } from './authStorage';
import type {
  CreateIngestionResponse,
  ExtractionRunResponse,
  IngestionStatusResponse,
} from '../types/api';

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Safe, serializable error surface. Never carries secrets or raw provider bodies. */
export class ApiError extends Error {
  readonly code: string; // stable error_code (problem+json) or a client-side code
  readonly status: number; // HTTP status, or 0 for network/timeout/config errors
  readonly correlationId?: string;
  readonly retriable: boolean;

  constructor(args: {
    code: string;
    status: number;
    message: string;
    correlationId?: string;
    retriable?: boolean;
  }) {
    super(args.message);
    this.name = 'ApiError';
    this.code = args.code;
    this.status = args.status;
    this.correlationId = args.correlationId;
    this.retriable = args.retriable ?? false;
  }
}

export interface RequestOptions {
  /** AbortController timeout in ms (default DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Override X-Correlation-Id (else a uuid v4 is generated per request). */
  correlationId?: string;
  /** Set Idempotency-Key (else none for JSON requests; auto-generated for uploads). */
  idempotencyKey?: string;
  /** Skip Bearer attachment AND the 401→sign-out reaction (used by the login call). */
  skipAuth?: boolean;
  /** Extra headers (lowest precedence). */
  headers?: Record<string, string>;
  /** Caller-controlled AbortSignal, composed with the timeout. */
  signal?: AbortSignal;
}

/** RN file part for multipart uploads. */
export interface UploadFilePart {
  uri: string;
  name: string;
  type: string; // mime type, e.g. "image/jpeg"
}

function resolveUrl(path: string): string {
  if (!API_BASE_URL) {
    throw new ApiError({
      code: 'CONFIG_ERROR',
      status: 0,
      message: 'EXPO_PUBLIC_API_BASE_URL is not configured',
    });
  }
  return `${API_BASE_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function parseError(response: Response, fallbackCorrelationId: string): Promise<ApiError> {
  // Read only the safe, stable RFC 9457 fields — never echo a raw body that could
  // contain unexpected content.
  let code = `HTTP_${response.status}`;
  let message = `request failed with status ${response.status}`;
  let retriable = response.status >= 500 || response.status === 429;
  let correlationId = fallbackCorrelationId;
  try {
    const body = await response.json();
    if (body && typeof body === 'object') {
      if (typeof body.error_code === 'string') code = body.error_code;
      if (typeof body.detail === 'string') message = body.detail;
      else if (typeof body.title === 'string') message = body.title;
      if (typeof body.retriable === 'boolean') retriable = body.retriable;
      if (typeof body.correlation_id === 'string') correlationId = body.correlation_id;
    }
  } catch {
    // non-JSON error body — keep the safe status-based defaults
  }
  return new ApiError({ code, status: response.status, message, correlationId, retriable });
}

async function send<T>(
  path: string,
  init: RequestInit,
  opts: RequestOptions,
  baseHeaders: Record<string, string>,
): Promise<T> {
  const url = resolveUrl(path);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const correlationId = opts.correlationId ?? uuidv4();

  // Attach the Bearer token on every authenticated request. The login call sets
  // skipAuth so it never carries (or reacts to) a stale token.
  const token = opts.skipAuth ? null : await getToken();

  const headers: Record<string, string> = {
    'X-Correlation-Id': correlationId,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
    ...baseHeaders,
    ...(opts.headers ?? {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(url, { ...init, headers, signal: controller.signal });
    if (!response.ok) {
      const apiError = await parseError(response, correlationId);
      // An authenticated request rejected with 401 => the session is no longer
      // valid: clear it and signal the auth layer (drops back to the login
      // screen). The login call sets skipAuth, so a bad-credentials 401 there
      // does NOT trigger a sign-out loop.
      if (response.status === 401 && !opts.skipAuth) {
        await clearToken();
        emitUnauthenticated();
      }
      throw apiError;
    }
    if (response.status === 204) return undefined as T;
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err; // already a typed, safe error
    const aborted = controller.signal.aborted;
    throw new ApiError({
      code: aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      status: 0,
      message: aborted ? `request timed out after ${timeoutMs}ms` : 'network request failed',
      correlationId,
      retriable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Typed JSON request (GET by default). `body` is JSON-encoded when provided. */
export function apiRequest<T>(
  path: string,
  options: RequestOptions & { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = 'GET', body, ...opts } = options;
  const baseHeaders: Record<string, string> = {};
  const init: RequestInit = { method };
  if (body !== undefined) {
    baseHeaders['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return send<T>(path, init, opts, baseHeaders);
}

/**
 * Typed multipart/form-data upload. The file part is appended as the RN
 * `{ uri, name, type }` object under the given field name (default "image").
 * Content-Type is left unset so fetch sets the multipart boundary. Idempotency-Key
 * is auto-generated when not supplied (uploads are unsafe writes).
 */
export function apiUpload<T>(
  path: string,
  parts: { file: UploadFilePart; fileField?: string; fields?: Record<string, string> },
  options: RequestOptions = {},
): Promise<T> {
  const form = new FormData();
  // RN accepts a { uri, name, type } object as a file part; cast for the DOM typing.
  form.append(parts.fileField ?? 'image', parts.file as unknown as Blob);
  if (parts.fields) {
    for (const [key, value] of Object.entries(parts.fields)) form.append(key, value);
  }
  const opts: RequestOptions = {
    ...options,
    idempotencyKey: options.idempotencyKey ?? uuidv4(),
  };
  return send<T>(path, { method: 'POST', body: form }, opts, {});
}

// ── Thin typed endpoint wrappers (prepared for the upcoming flow; not yet called) ──

/** POST /v1/ingestions — upload a label image; returns the accepted ingestion. */
export function createIngestion(
  file: UploadFilePart,
  fields: { barcode_raw?: string; client_captured_at?: string } = {},
  options: RequestOptions = {},
): Promise<CreateIngestionResponse> {
  const formFields: Record<string, string> = {};
  if (fields.barcode_raw) formFields.barcode_raw = fields.barcode_raw;
  if (fields.client_captured_at) formFields.client_captured_at = fields.client_captured_at;
  return apiUpload<CreateIngestionResponse>('/v1/ingestions', { file, fields: formFields }, options);
}

/** GET /v1/ingestions/{id} — current ingestion status + extraction runs. */
export function getIngestionStatus(
  ingestionId: string,
  options: RequestOptions = {},
): Promise<IngestionStatusResponse> {
  return apiRequest<IngestionStatusResponse>(`/v1/ingestions/${encodeURIComponent(ingestionId)}`, options);
}

/** GET /v1/extraction-runs/{id} — a single run with its extracted fields. */
export function getExtractionRun(
  runId: string,
  options: RequestOptions = {},
): Promise<ExtractionRunResponse> {
  return apiRequest<ExtractionRunResponse>(`/v1/extraction-runs/${encodeURIComponent(runId)}`, options);
}

// Re-export the API types for convenient single-import consumption.
export type {
  CreateIngestionResponse,
  IngestionStatusResponse,
  ExtractionRunResponse,
  ExtractionRunSummary,
  ExtractionField,
  ValidationStatus,
  ConfidenceBand,
  IngestionStatus,
} from '../types/api';
