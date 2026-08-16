import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export function ProductPhotoViewer({ url, onClose, rotationDegrees = 0 }: { url: string; onClose: () => void; rotationDegrees?: 0 | 180 }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

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
        <img src={url} alt="Étiquette du produit agrandie" style={{ transform: `rotate(${rotationDegrees - 90}deg)` }} />
      </div>
    </div>,
    document.body,
  );
}
