import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

import { arrivalImagePath, authorizedFetch } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { BrandMark } from '../../BrandMark';

export function ArrivalImage({
  batchId,
  available,
  alt = '',
  onOpen,
  rotationDegrees = 0,
  baseRotationDegrees = -90,
  variant = 'thumbnail',
  eager = false,
}: {
  batchId: string;
  available: boolean;
  alt?: string;
  onOpen?: (url: string) => void;
  rotationDegrees?: 0 | 180;
  baseRotationDegrees?: -90 | 0;
  variant?: 'source' | 'thumbnail';
  eager?: boolean;
}) {
  const { session } = useAuth();
  const [url, setUrl] = useState<string>();
  const [shouldLoad, setShouldLoad] = useState(eager);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'decoding' | 'loaded' | 'error'>('idle');
  const [attempt, setAttempt] = useState(0);
  const quarterTurn = baseRotationDegrees === -90;
  const frameRef = useRef<HTMLElement | null>(null);
  const setFrameRef = useCallback((node: HTMLElement | null) => { frameRef.current = node; }, []);
  const imageStyle = {
    '--arrival-photo-rotation': `${rotationDegrees - (quarterTurn ? 90 : 0)}deg`,
  } as CSSProperties;

  useEffect(() => {
    if (!available) return;
    if (eager || typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldLoad(true);
      observer.disconnect();
    }, { rootMargin: '320px 0px' });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [available, eager]);

  useEffect(() => {
    if (!available || !session || !shouldLoad) return;
    let active = true;
    let objectUrl = '';
    let retryTimer: number | undefined;
    const controller = new AbortController();
    setUrl(undefined);
    setLoadState('loading');
    authorizedFetch(arrivalImagePath(batchId, variant), session, { signal: controller.signal })
      .then((response) => response.ok ? response.blob() : Promise.reject(new Error('Photo indisponible')))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) {
          setUrl(objectUrl);
          setLoadState('decoding');
        }
      })
      .catch((cause) => {
        if (!active || !(cause instanceof Error) || cause.name === 'AbortError') return;
        setLoadState('error');
        if (attempt === 0) retryTimer = window.setTimeout(() => setAttempt(1), 1600);
      });
    return () => {
      active = false;
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attempt, available, batchId, session, shouldLoad, variant]);

  if (!available) return <div className="image-placeholder" aria-label="Photo indisponible"><BrandMark /></div>;

  const image = url ? <img
    src={url}
    alt={alt}
    style={imageStyle}
    className={`${loadState === 'loaded' ? 'is-ready' : ''} ${quarterTurn ? 'requires-quarter-turn' : ''}`.trim()}
    decoding="async"
    onLoad={() => setLoadState('loaded')}
    onError={() => setLoadState('error')}
  /> : null;
  const feedback = loadState !== 'loaded' ? <span
    className={`arrival-image-loading is-${loadState}`}
    role={loadState === 'idle' ? undefined : 'status'}
    aria-hidden={loadState === 'idle' ? true : undefined}
    aria-label={loadState === 'error' ? 'Photo indisponible' : 'Chargement de la photo'}
  ><BrandMark /></span> : null;

  if (onOpen) return <button
    ref={setFrameRef}
    className="arrival-image arrival-image-button"
    type="button"
    disabled={!url || loadState === 'error'}
    onClick={() => { if (url) onOpen(url); }}
    aria-label="Agrandir la photo du produit"
  >
    {image}
    {feedback}
    {loadState === 'loaded' && <span className="arrival-image-hint" aria-hidden="true">Agrandir ↗</span>}
  </button>;

  return <span ref={setFrameRef} className="arrival-image">
    {image}
    {feedback}
  </span>;
}
