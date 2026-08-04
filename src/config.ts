/**
 * App configuration — read from Expo public env vars (`process.env.EXPO_PUBLIC_*`,
 * inlined at build time).
 *
 * Nothing secret lives here — and nothing secret CAN live here: EXPO_PUBLIC_* values
 * are baked into the JS bundle and extractable from any build (which is why the
 * legacy on-device OCR key was removed, audit §7.3).
 */

/**
 * Backend base URL, e.g. "https://api.example.com" or "http://192.168.1.10:8000".
 * Empty when unset — the API client throws a clear error instead of guessing a host.
 */
declare const __DEV__: boolean | undefined;

export function validateApiBaseUrl(value: string, isDev: boolean): string {
  const normalized = value.trim();
  if (!isDev && normalized.toLowerCase().startsWith('http://')) {
    throw new Error('Release builds require an HTTPS EXPO_PUBLIC_API_BASE_URL');
  }
  return normalized;
}

export const API_BASE_URL: string = validateApiBaseUrl(
  process.env.EXPO_PUBLIC_API_BASE_URL ?? '',
  typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production',
);

/**
 * Capture path selector. Backend extraction is the DEFAULT saved-article path.
 * EXPO_PUBLIC_BACKEND_FIRST=false (or 0) is an UNSUPPORTED opt-out: the legacy
 * on-device OCR was removed (audit §7.3), so the camera now refuses to submit in
 * that mode. Missing / any other value => backend mode.
 */
function backendFirstFromEnv(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0');
}

export const BACKEND_FIRST: boolean = backendFirstFromEnv(process.env.EXPO_PUBLIC_BACKEND_FIRST);

// Authentication is now real JWT: the app obtains a token via POST /v1/auth/login
// (services/auth.ts) and the API client attaches `Authorization: Bearer <token>`
// (services/api.ts). The previous X-Actor-Id/X-Principal/X-Scopes dev seam is gone.
