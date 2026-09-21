import { useEffect, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import {
  photoUsesQuarterTurnLayout,
  resolvedPhotoRotationDegrees,
  type PhotoBaseRotationDegrees,
  type PhotoRotationDegrees,
} from './photoOrientation';

export function ProductPhotoViewer({ url, onClose, rotationDegrees = 0, baseRotationDegrees = -90 }: { url: string; onClose: () => void; rotationDegrees?: PhotoRotationDegrees; baseRotationDegrees?: PhotoBaseRotationDegrees }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const resolvedRotation = resolvedPhotoRotationDegrees(rotationDegrees, baseRotationDegrees);
  const quarterTurn = photoUsesQuarterTurnLayout(rotationDegrees, baseRotationDegrees);
  const imageStyle = {
    '--photo-viewer-rotation': `${resolvedRotation}deg`,
  } as CSSProperties;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div className="photo-viewer" role="dialog" aria-modal="true" aria-label="Photo agrandie du produit" onMouseDown={onClose}>
      <div className="photo-viewer-toolbar" onMouseDown={(event) => event.stopPropagation()}>
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Fermer la photo agrandie">×</button>
      </div>
      <div className="photo-viewer-stage" onMouseDown={(event) => event.stopPropagation()}>
        <div className={`photo-viewer-image-frame${quarterTurn ? ' photo-viewer-image-frame--quarter-turn' : ''}`}>
          <img src={url} alt="Étiquette du produit agrandie" style={imageStyle} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
