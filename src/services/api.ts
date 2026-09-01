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
import { fetch as expoFetch, type FetchRequestInit } from 'expo/fetch';
import { v4 as uuidv4 } from 'uuid';
import * as FileSystem from 'expo-file-system/legacy';

import { API_BASE_URL } from '../config';
import {
  captureActiveSession,
  clearSessionTokens,
  clearUsername,
  emitUnauthenticated,
  getRefreshToken,
  getToken,
  isSessionFenceCurrent,
  setOperatorContext,
  setTokensForSession,
  type SessionFence,
} from './authStorage';
import { isTradeCode } from './businessProfiles';
import type {
  CreateIngestionResponse,
  ExtractionRunResponse,
  IngestionStatusResponse,
} from '../types/api';

const DEFAULT_TIMEOUT_MS = 30_000;

type HttpResponse = Pick<Response, 'json' | 'ok' | 'status' | 'text'>;

/**
 * Android JSON transport.
 *
 * The React Native legacy fetch bridge can collapse Android DNS/TLS failures into
 * an opaque `Network request failed` before the request reaches Caddy. Expo SDK 54
 * ships a native WinterCG fetch implementation specifically for consistent mobile
 * networking. Keep iOS on its proven transport and keep multipart uploads on the
 * legacy bridge, whose `{ uri, name, type }` file parts are React-Native-specific.
 */
async function fetchJson(url: string, init: RequestInit): Promise<HttpResponse> {
  if (process.env.EXPO_OS === 'android') {
    return expoFetch(url, init as FetchRequestInit);
  }
  return globalThis.fetch(url, init);
}

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
  /** Extra non-security headers. Auth/correlation/idempotency/content-type cannot be overridden. */
  headers?: Record<string, string>;
  /** Caller-controlled AbortSignal, composed with the timeout. */
  signal?: AbortSignal;
  /** Internal guard: an authenticated request is retried at most once. */
  authRetried?: boolean;
}

let refreshState: { fence: SessionFence; promise: Promise<string | null> } | null = null;

async function refreshAccessToken(fence: SessionFence): Promise<string | null> {
  if (!isSessionFenceCurrent(fence)) return null;
  if (
    refreshState &&
    refreshState.fence.generation === fence.generation &&
    isSessionFenceCurrent(refreshState.fence)
  ) {
    return refreshState.promise;
  }
  const promise = (async () => {
    const refreshToken = await getRefreshToken();
    if (!refreshToken || !isSessionFenceCurrent(fence)) return null;
    // A shared refresh has its own fixed deadline. It must not inherit one caller's
    // signal, but it must still abort on session revocation and cannot hang every
    // authenticated request forever when the refresh endpoint stalls.
    const controller = new AbortController();
    const abortFromFence = () => controller.abort();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    if (fence.signal.aborted) controller.abort();
    else fence.signal.addEventListener('abort', abortFromFence, { once: true });
    try {
      const response = await fetchJson(resolveUrl('/v1/mobile/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const body = await response.json();
      if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
        return null;
      }
      if (
        body.user?.role !== 'manager' ||
        typeof body.user.id !== 'string' ||
        typeof body.user.organization_id !== 'string' ||
        typeof body.user.business_portal_id !== 'string' ||
        !isTradeCode(body.user.trade_code)
      ) {
        return null;
      }
      if (!isSessionFenceCurrent(fence)) return null;
      const tokensRotated = await setTokensForSession(
        fence,
        body.access_token,
        body.refresh_token,
      );
      if (!tokensRotated || !isSessionFenceCurrent(fence)) return null;
      await setOperatorContext({
        organizationId: body.user.organization_id,
        actorId: body.user.id,
        businessPortalId: body.user.business_portal_id,
        tradeCode: body.user.trade_code,
      });
      if (!isSessionFenceCurrent(fence)) return null;
      return body.access_token;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      fence.signal.removeEventListener('abort', abortFromFence);
    }
  })();
  refreshState = { fence, promise };
  try {
    return await promise;
  } finally {
    if (refreshState?.promise === promise) refreshState = null;
  }
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

async function parseError(response: HttpResponse, fallbackCorrelationId: string): Promise<ApiError> {
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
  transport: (url: string, init: RequestInit) => Promise<HttpResponse>,
  responseType: 'json' | 'text' = 'json',
  inheritedFence?: SessionFence,
): Promise<T> {
  const url = resolveUrl(path);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const correlationId = opts.correlationId ?? uuidv4();

  // Bind the whole request/refresh/retry lifecycle to the identity that initiated
  // it. A late 401 from session A must never refresh or clear session B.
  const fence = opts.skipAuth
    ? null
    : inheritedFence ?? await captureActiveSession();
  if (!opts.skipAuth && (!fence || !isSessionFenceCurrent(fence))) {
    throw new ApiError({
      code: 'SESSION_CHANGED',
      status: 0,
      message: 'authenticated session changed before the request started',
      correlationId,
      retriable: false,
    });
  }

  // Attach the Bearer token on every authenticated request. The login call sets
  // skipAuth so it never carries (or reacts to) a stale token.
  const token = opts.skipAuth ? null : await getToken();
  if (fence && !isSessionFenceCurrent(fence)) {
    throw new ApiError({
      code: 'SESSION_CHANGED',
      status: 0,
      message: 'authenticated session changed before transport',
      correlationId,
      retriable: false,
    });
  }

  const protectedNames = new Set([
    'authorization',
    'x-correlation-id',
    'idempotency-key',
    'content-type',
  ]);
  const safeExtraHeaders = Object.fromEntries(
    Object.entries(opts.headers ?? {}).filter(([name]) => !protectedNames.has(name.toLowerCase())),
  );
  const headers: Record<string, string> = {
    ...safeExtraHeaders,
    ...baseHeaders,
    'X-Correlation-Id': correlationId,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();
  const abortSignals = new Set<AbortSignal>();
  if (opts.signal) abortSignals.add(opts.signal);
  if (fence) abortSignals.add(fence.signal);
  for (const signal of abortSignals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortFromCaller, { once: true });
  }

  try {
    const response = await transport(url, { ...init, headers, signal: controller.signal });
    if (fence && !isSessionFenceCurrent(fence)) {
      throw new ApiError({
        code: 'SESSION_CHANGED',
        status: 0,
        message: 'authenticated session changed during transport',
        correlationId,
        retriable: false,
      });
    }
    if (!response.ok) {
      if (response.status === 401 && !opts.skipAuth && !opts.authRetried) {
        const refreshed = fence ? await refreshAccessToken(fence) : null;
        if (refreshed && fence && isSessionFenceCurrent(fence)) {
          return send<T>(
            path,
            init,
            { ...opts, authRetried: true },
            baseHeaders,
            transport,
            responseType,
            fence,
          );
        }
      }
      const apiError = await parseError(response, correlationId);
      // An authenticated request rejected with 401 => the session is no longer
      // valid: clear it and signal the auth layer (drops back to the login
      // screen). The login call sets skipAuth, so a bad-credentials 401 there
      // does NOT trigger a sign-out loop.
      if (
        response.status === 401 &&
        !opts.skipAuth &&
        fence &&
        isSessionFenceCurrent(fence)
      ) {
        // Both async calls invalidate their in-memory state synchronously. Notify
        // React before awaiting a potentially slow native keychain deletion so the
        // revoked account's UI/data close immediately; the purge still completes
        // before this request settles.
        const credentialPurge = Promise.allSettled([clearSessionTokens(), clearUsername()]);
        emitUnauthenticated();
        const purgeResults = await credentialPurge;
        if (purgeResults.some((result) => result.status === 'rejected')) {
          throw new ApiError({
            code: 'SECURE_SESSION_PURGE_FAILED',
            status: 0,
            message: 'local session credentials could not be removed',
            correlationId,
            retriable: false,
          });
        }
      }
      throw apiError;
    }
    if (response.status === 204) return undefined as T;
    const body = await response.text();
    if (fence && !isSessionFenceCurrent(fence)) {
      throw new ApiError({
        code: 'SESSION_CHANGED',
        status: 0,
        message: 'authenticated session changed while reading response',
        correlationId,
        retriable: false,
      });
    }
    if (responseType === 'text') return body as T;
    try {
      if (!body) throw new SyntaxError('empty JSON response');
      return JSON.parse(body) as T;
    } catch {
      throw new ApiError({
        code: 'INVALID_RESPONSE',
        status: response.status,
        message: 'server returned an invalid JSON response',
        correlationId,
        retriable: false,
      });
    }
  } catch (err) {
    if (err instanceof ApiError) throw err; // already a typed, safe error
    if (fence && !isSessionFenceCurrent(fence)) {
      throw new ApiError({
        code: 'SESSION_CHANGED',
        status: 0,
        message: 'authenticated session changed during request',
        correlationId,
        retriable: false,
      });
    }
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
    for (const signal of abortSignals) signal.removeEventListener('abort', abortFromCaller);
  }
}

/** Authenticated text download using the same refresh, timeout and header guards. */
export function apiTextRequest(
  path: string,
  options: RequestOptions & { method?: string } = {},
): Promise<string> {
  const { method = 'GET', ...opts } = options;
  return send<string>(path, { method }, opts, {}, fetchJson, 'text');
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
  return send<T>(path, init, opts, baseHeaders, fetchJson);
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
  // RN's fetch reads the file uri straight off disk to build the multipart body; if the
  // OS already purged the cache uri (expo-camera's Camera/ dir, ImageManipulator's cache,
  // or a pending/ photo deleted after the scan was discarded) it throws a low-level
  // NSCocoaErrorDomain 260 "no such file" that surfaces here as a generic retriable
  // NETWORK_ERROR — which then retries 5× with a scary native log for a file that will
  // never come back. Verify existence once at the upload chokepoint and fail fast +
  // non-retryably so the op dead-letters cleanly and the card shows "Envoi impossible".
  return (async () => {
    try {
      const info = await FileSystem.getInfoAsync(parts.file.uri);
      if (!info.exists) {
        throw new ApiError({
          code: 'FILE_NOT_FOUND',
          status: 0,
          message: `upload file no longer exists: ${parts.file.uri}`,
          retriable: false,
        });
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // getInfoAsync itself failed (permission / IO) — treat as non-retryable too.
      throw new ApiError({
        code: 'FILE_NOT_FOUND',
        status: 0,
        message: `upload file unreadable: ${parts.file.uri}`,
        retriable: false,
      });
    }
    // RN accepts a { uri, name, type } object as a file part; cast for the DOM typing.
    form.append(parts.fileField ?? 'image', parts.file as unknown as Blob);
    if (parts.fields) {
      for (const [key, value] of Object.entries(parts.fields)) form.append(key, value);
    }
    const opts: RequestOptions = {
      ...options,
      idempotencyKey: options.idempotencyKey ?? uuidv4(),
    };
    return send<T>(path, { method: 'POST', body: form }, opts, {}, globalThis.fetch);
  })();
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

/**
 * GET /v1/ingestions/{id} — current ingestion status + extraction runs.
 *
 * Long-poll (Tier 4): pass BOTH `waitSeconds` and `lastStatus` to let the server
 * hold the request (bounded, ≤25 s server-side) until the status differs from
 * `lastStatus` — the caller must size `timeoutMs` above the wait. Omitted = the
 * classic immediate GET.
 */
export function getIngestionStatus(
  ingestionId: string,
  options: RequestOptions & { waitSeconds?: number; lastStatus?: string } = {},
): Promise<IngestionStatusResponse> {
  const { waitSeconds, lastStatus, ...opts } = options;
  let path = `/v1/ingestions/${encodeURIComponent(ingestionId)}`;
  if (waitSeconds && waitSeconds > 0 && lastStatus) {
    // Manual query build — React Native's URL polyfill does NOT implement
    // URLSearchParams.toString() (it throws at runtime; Node's does, so Jest
    // would never catch it). encodeURIComponent is universally available.
    path += `?wait=${encodeURIComponent(String(waitSeconds))}&last_status=${encodeURIComponent(lastStatus)}`;
  }
  return apiRequest<IngestionStatusResponse>(path, opts);
}

/** Response of POST /v1/ingestions/{id}/confirm (the finalized review state). */
export interface ConfirmIngestionResponse {
  ingestion_id: string;
  status: string; // 'confirmed'
  replayed: boolean; // true => it was already confirmed (idempotent repeat)
}

/**
 * POST /v1/ingestions/{id}/confirm — the reviewer finalizes the arrivage (P3).
 * Idempotent server-side; 409 INGESTION_NOT_CONFIRMABLE if the extraction is not
 * review-ready (a state error, not worth a blind retry).
 */
export function confirmIngestion(
  ingestionId: string,
  options: RequestOptions = {},
): Promise<ConfirmIngestionResponse> {
  return apiRequest<ConfirmIngestionResponse>(
    `/v1/ingestions/${encodeURIComponent(ingestionId)}/confirm`,
    { ...options, method: 'POST' },
  );
}

export interface FinalizeReviewResponse {
  ingestion_id: string;
  run_id: string;
  status: 'confirmed';
  replayed: boolean;
}

/** Persist the complete versioned profile and confirmation in one idempotent server commit. */
export function finalizeReview(
  ingestionId: string,
  fields: Record<string, string | null>,
  note?: string,
  photoRotationDegrees: 0 | 180 = 0,
  photoBaseRotationDegrees: -90 | 0 = -90,
  options: RequestOptions = {},
): Promise<FinalizeReviewResponse> {
  return apiRequest<FinalizeReviewResponse>(
    `/v1/ingestions/${encodeURIComponent(ingestionId)}/reviews`,
    {
      method: 'POST',
      body: {
        fields,
        photo_rotation_degrees: photoRotationDegrees,
        photo_base_rotation_degrees: photoBaseRotationDegrees,
        ...(note ? { note } : {}),
      },
      ...options,
    },
  );
}

/** GET /v1/extraction-runs/{id} — a single run with its extracted fields. */
export function getExtractionRun(
  runId: string,
  options: RequestOptions = {},
): Promise<ExtractionRunResponse> {
  return apiRequest<ExtractionRunResponse>(`/v1/extraction-runs/${encodeURIComponent(runId)}`, options);
}

/** Response of PATCH /v1/ingestions/{id}/fields/{name} (the persisted human field). */
export interface OverrideFieldResponse {
  ingestion_id: string;
  run_id: string;
  field_name: string;
  value: string | null;
  validation_status: string;
  source: string; // 'human'
  combined_confidence: number;
  confidence_band: string;
  replayed: boolean; // true => the value was already recorded (no new run)
}

/**
 * PATCH /v1/ingestions/{id}/fields/{name} — record a human-validated correction on the
 * AUTHORITATIVE backend store (append-only, source='human'). `value: null` clears the
 * field. GS1-owned fields (lot/DLC/weight/GTIN/packaging) require the explicit
 * `forceGs1` flag — without it the server answers FIELD_NOT_EDITABLE / 409; with it
 * the override is audited under a dedicated action. See audit §4.2 + workflow v1.
 */
export function overrideField(
  ingestionId: string,
  fieldName: string,
  value: string | null,
  note?: string,
  options: RequestOptions & { forceGs1?: boolean } = {},
): Promise<OverrideFieldResponse> {
  const { forceGs1, ...opts } = options;
  return apiRequest<OverrideFieldResponse>(
    `/v1/ingestions/${encodeURIComponent(ingestionId)}/fields/${encodeURIComponent(fieldName)}`,
    {
      method: 'PATCH',
      body: { value, note, ...(forceGs1 ? { force_gs1: true } : {}) },
      ...opts,
    },
  );
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
