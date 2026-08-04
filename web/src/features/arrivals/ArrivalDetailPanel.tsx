import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'wouter';

import { getArrival } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { portalDefinition } from '../../portals/registry';
import type { ArrivalDetail, Store } from '../../types';
import { ArrivalImage } from './ArrivalImage';
import { DetailSections } from './DetailSections';

function display(value: string | null | undefined): string {
  return value?.trim() || 'Non renseigné';
}

export function ArrivalDetailPanel({ stores }: { stores: Store[] }) {
  const { session } = useAuth();
  const { organizationSlug = 'labelscan', profession, arrivalId } = useParams();
  const [, navigate] = useLocation();
  const [detail, setDetail] = useState<ArrivalDetail>();
  const [error, setError] = useState('');
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const portal = portalDefinition(profession);
  const closePath = `/o/${organizationSlug}/portails/${profession}/arrivages`;

  useEffect(() => {
    if (!arrivalId || !session) return;
    const controller = new AbortController();
    setDetail(undefined);
    setError('');
    getArrival(session, arrivalId, controller.signal)
      .then(setDetail)
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Détail indisponible'); });
    return () => controller.abort();
  }, [arrivalId, session]);

  useEffect(() => {
    if (!arrivalId) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        navigate(closePath);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [arrivalId, closePath, navigate]);

  const store = useMemo(() => stores.find((item) => item.code === detail?.store_code), [detail?.store_code, stores]);
  if (!arrivalId) return null;

  return <div className="drawer-backdrop" onMouseDown={() => navigate(closePath)}>
    <aside ref={drawerRef} className="detail-drawer" role="dialog" aria-modal="true" aria-label="Détail de l’arrivage" onMouseDown={(event) => event.stopPropagation()}>
      <header className="drawer-header"><div><span className="eyebrow">{portal?.shortLabel}</span><h2>Fiche d’arrivage</h2></div><button ref={closeButtonRef} className="icon-button" onClick={() => navigate(closePath)} aria-label="Fermer">×</button></header>
      {error && <div className="notice error" role="alert">{error}</div>}
      {!detail && !error && <div className="drawer-loading"><div className="loader" /><p>Chargement de la fiche…</p></div>}
      {detail && <>
        <ArrivalImage batchId={detail.batch_id} available={detail.photo_available} alt="Étiquette du produit" />
        <section className="detail-identity"><h3>{display(detail.fields.commercial_designation)}</h3><p>{store?.name ?? detail.store_code ?? 'Magasin non renseigné'} · Révision {detail.revision_no}{detail.completeness !== undefined ? ` · Complétude ${detail.completeness} %` : ''}</p></section>
        {portal && <DetailSections sections={portal.detailSections} fields={detail.fields} />}
      </>}
    </aside>
  </div>;
}
