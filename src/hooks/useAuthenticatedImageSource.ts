import { useEffect, useState } from 'react';
import { API_BASE_URL } from '../config';
import { getToken, onAccessTokenChanged } from '../services/authStorage';

export interface AuthenticatedImageSource {
  uri: string;
  headers?: Record<string, string>;
}

/** Only the configured backend origin may ever receive the session bearer. */
export function isTrustedApiImageUri(uri: string): boolean {
  if (!/^https?:\/\//i.test(uri) || !API_BASE_URL) return false;
  const base = API_BASE_URL.replace(/\/+$/, '');
  return uri === base || uri.startsWith(`${base}/`);
}

/**
 * Build an authenticated remote-image source in volatile React state.
 *
 * The bearer is intentionally absent from Article records, React Query and
 * AsyncStorage. Local file URIs never receive an Authorization header.
 */
export function useAuthenticatedImageSource(
  uri: string | null | undefined,
): AuthenticatedImageSource | undefined {
  const [source, setSource] = useState<AuthenticatedImageSource | undefined>();

  useEffect(() => {
    let active = true;
    if (!uri) {
      setSource(undefined);
      return () => {
        active = false;
      };
    }
    if (!/^https?:\/\//i.test(uri)) {
      setSource({ uri });
      return () => {
        active = false;
      };
    }
    if (!isTrustedApiImageUri(uri)) {
      // Fail closed: legacy/external URLs are not loaded and never receive a bearer.
      setSource(undefined);
      return () => {
        active = false;
      };
    }
    const applyToken = (token: string | null) => {
      if (!active) return;
      setSource(token ? { uri, headers: { Authorization: `Bearer ${token}` } } : undefined);
    };
    const unsubscribe = onAccessTokenChanged(applyToken);
    void getToken().then(applyToken);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [uri]);

  return source;
}
