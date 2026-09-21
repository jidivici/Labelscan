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
  return useAuthenticatedImage(uri).source;
}

/** Loading controls are used by Android's download/retry placeholders. */
export function useAuthenticatedImage(uri: string | null | undefined) {
  const [state, setState] = useState<{
    requestedUri: string;
    source?: AuthenticatedImageSource;
    failed?: boolean;
  }>();
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    let active = true;
    let requestVersion = 0;
    const setSource = (source: AuthenticatedImageSource | undefined) => {
      if (active) setState(source && uri ? { requestedUri: uri, source } : undefined);
    };
    setSource(undefined);
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
      const version = ++requestVersion;
      if (!token) {
        setSource(undefined);
      } else if (process.env.EXPO_OS === 'android') {
        // The catalogue JSON and photos now share transport, token refresh and
        // logout cancellation. Image only receives a local path on Android.
        void import('../services/remoteArticlePhoto').then(({ loadRemoteArticlePhoto }) => {
          if (!active || version !== requestVersion) return undefined;
          return loadRemoteArticlePhoto(uri);
        }).then((localUri) => {
          if (!localUri) return;
          if (version === requestVersion) setSource({ uri: localUri });
        }).catch(() => {
          if (active && version === requestVersion) setState({ requestedUri: uri, failed: true });
        });
      } else {
        setSource({ uri, headers: { Authorization: `Bearer ${token}` } });
      }
    };
    const unsubscribe = onAccessTokenChanged(applyToken);
    const initialVersion = requestVersion;
    void getToken().then((token) => {
      if (initialVersion === requestVersion) applyToken(token);
    }).catch(() => {
      if (active && initialVersion === requestVersion) {
        setState({ requestedUri: uri, failed: process.env.EXPO_OS === 'android' });
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [uri, retryVersion]);

  // Do not render the preceding article's photo while a changed URI loads.
  const current = state && state.requestedUri === uri ? state : undefined;
  return {
    source: current?.source,
    failed: current?.failed === true,
    retry: () => {
      if (!uri || process.env.EXPO_OS !== 'android') return;
      setState(undefined);
      void import('../services/remoteArticlePhoto').then(({ invalidateRemoteArticlePhoto }) =>
        invalidateRemoteArticlePhoto(uri),
      ).then(() => setRetryVersion((version) => version + 1)).catch(() => {
        setState({ requestedUri: uri, failed: true });
      });
    },
    onError: process.env.EXPO_OS === 'android' && uri && /^https?:\/\//i.test(uri)
      ? () => setState((latest) => latest?.requestedUri === uri
        ? { requestedUri: uri, failed: true }
        : latest)
      : undefined,
  };
}
