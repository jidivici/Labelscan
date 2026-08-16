import { useEffect, useState, type CSSProperties } from 'react';

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
}: {
  batchId: string;
  available: boolean;
  alt?: string;
  onOpen?: (url: string) => void;
  rotationDegrees?: 0 | 180;
  baseRotationDegrees?: -90 | 0;
}) {
  const { session } = useAuth();
  const [url, setUrl] = useState<string>();
  const imageStyle = {
    '--arrival-photo-rotation': `${rotationDegrees + baseRotationDegrees}deg`,
  } as CSSProperties;

  useEffect(() => {
    if (!available || !session) return;
    let active = true;
    let objectUrl = '';
    authorizedFetch(arrivalImagePath(batchId), session)
      .then((response) => response.ok ? response.blob() : Promise.reject(new Error('Photo indisponible')))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [available, batchId, session]);

  if (url && onOpen) {
    return <button className="arrival-image arrival-image-button" type="button" onClick={() => onOpen(url)} aria-label="Agrandir la photo du produit">
      <img src={url} alt={alt} style={imageStyle} />
      <span className="arrival-image-hint" aria-hidden="true">Agrandir ↗</span>
    </button>;
  }

  return url
    ? <span className="arrival-image"><img src={url} alt={alt} style={imageStyle} /></span>
    : <div className="image-placeholder" aria-label="Photo indisponible"><BrandMark /></div>;
}
