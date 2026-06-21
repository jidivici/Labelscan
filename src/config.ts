/**
 * App configuration — read from Expo public env vars (`process.env.EXPO_PUBLIC_*`,
 * inlined at build time). Mirrors the existing pattern used by src/services/ocr.ts.
 *
 * Nothing secret lives here. The dev-auth values below are a TEMPORARY seam (see
 * src/services/api.ts) and must never carry a privileged production identity —
 * they are sourced from env only, with no hardcoded defaults.
 */

/**
 * Backend base URL, e.g. "https://api.example.com" or "http://192.168.1.10:8000".
 * Empty when unset — the API client throws a clear error instead of guessing a host.
 */
export const API_BASE_URL: string = (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').trim();

/**
 * Capture path selector. Backend extraction is the DEFAULT saved-article path;
 * legacy on-device OCR is a fallback only when explicitly opted out via
 * EXPO_PUBLIC_BACKEND_FIRST=false (or 0). Missing / any other value => backend mode.
 */
function backendFirstFromEnv(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0');
}

export const BACKEND_FIRST: boolean = backendFirstFromEnv(process.env.EXPO_PUBLIC_BACKEND_FIRST);

// Authentication is now real JWT: the app obtains a token via POST /v1/auth/login
// (services/auth.ts) and the API client attaches `Authorization: Bearer <token>`
// (services/api.ts). The previous X-Actor-Id/X-Principal/X-Scopes dev seam is gone.
