import { useEffect, useState } from 'react';

import { arrivalImagePath, authorizedFetch } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { BrandMark } from '../../BrandMark';

export function ArrivalImage({ batchId, available, alt = '' }: { batchId: string; available: boolean; alt?: string }) {
  const { session } = useAuth();
  const [url, setUrl] = useState<string>();

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

  return url
    ? <span className="arrival-image"><img src={url} alt={alt} /></span>
    : <div className="image-placeholder" aria-label="Photo indisponible"><BrandMark /></div>;
}
