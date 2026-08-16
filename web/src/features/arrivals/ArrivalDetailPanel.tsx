import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams, useSearch } from 'wouter';

import { getArrival } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { portalDefinition } from '../../portals/registry';
import type { PortalDetailSection } from '../../portals/types';
import type { ArrivalDetail, Store } from '../../types';
import { ArrivalImage } from './ArrivalImage';
import { DetailSections } from './DetailSections';
import { ProductPhotoViewer } from './ProductPhotoViewer';

function display(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(date);
}

function formatDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(date);
}

function fieldLabel(key: string): string {
  return key.replaceAll('_', ' ').replace(/^./, (letter) => letter.toLocaleUpperCase('fr-FR'));
}

function productionMethodLabel(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  if (value === 'wild_caught') return 'Pêche sauvage';
  if (value === 'farmed') return 'Élevage';
  return value;
}

export function ArrivalDetailPanel({ stores }: { stores: Store[] }) {
  const { session } = useAuth();
  const { organizationSlug = 'labelscan', profession: routeProfession, arrivalId } = useParams();
  const search = useSearch();
  const [location, navigate] = useLocation();
  const profession = routeProfession ?? (location.includes('/portails/tous/') ? 'tous' : undefined);
  const [detail, setDetail] = useState<ArrivalDetail>();
  const [error, setError] = useState('');
  const [photoViewerUrl, setPhotoViewerUrl] = useState<string>();
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const routePortal = portalDefinition(profession);
  const closePath = `/o/${organizationSlug}/portails/${profession}/arrivages${search ? `?${search}` : ''}`;

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
  const detailPortal = portalDefinition(detail?.profession_code) ?? routePortal;
  const detailSections = useMemo<readonly PortalDetailSection[]>(() => {
    if (!detail) return detailPortal?.detailSections ?? [];
    const configured = detailPortal?.detailSections ?? [];
    const knownFields = new Set(configured.flatMap((section) => section.fields.map((field) => field.key)));
    const additionalFields = Object.keys(detail.fields)
      .filter((key) => !knownFields.has(key) && Boolean(detail.fields[key]?.trim()))
      .sort((left, right) => left.localeCompare(right, 'fr'))
      .map((key) => ({ key, label: fieldLabel(key), format: 'text' as const }));
    return additionalFields.length > 0
      ? [...configured, { id: 'additional', title: 'Informations complémentaires', fields: additionalFields }]
      : configured;
  }, [detail, detailPortal]);

  if (!arrivalId) return null;
  const lot = detail?.fields.batch_number ?? detail?.fields.lot_number ?? detail?.fields.lot_code;
  const supplier = detail?.fields.reseller_brand ?? detail?.fields.supplier_name ?? detail?.fields.supplier ?? detail?.fields.producer_name;
  const productName = display(detail?.fields.commercial_designation ?? detail?.fields.product_name) ?? (lot ? `Lot ${lot}` : detail?.batch_id);
  const description = [display(detail?.fields.scientific_name), display(supplier)].filter(Boolean).join(' · ');
  const productionMethod = productionMethodLabel(detail?.fields.production_method);
  const summaryFacts = detail ? [
    lot ? { label: 'N° de lot', value: lot } : null,
    display(detail.fields.expiry_date) ? { label: 'Date limite', value: formatDate(display(detail.fields.expiry_date)!) } : null,
    display(detail.fields.origin_country) ? { label: 'Origine', value: display(detail.fields.origin_country)! } : null,
    display(detail.fields.FAO_area) ? { label: 'Zone FAO', value: display(detail.fields.FAO_area)! } : null,
  ].filter((fact): fact is { label: string; value: string } => fact !== null) : [];
  const fieldCount = detail ? detailSections.reduce(
    (count, section) => count + section.fields.filter((field) => Boolean(detail.fields[field.key]?.trim())).length,
    0,
  ) : 0;

  return <div className="drawer-backdrop" onMouseDown={() => navigate(closePath)}>
    <aside ref={drawerRef} className="detail-drawer" role="dialog" aria-modal="true" aria-label="Détail de l’arrivage" onMouseDown={(event) => event.stopPropagation()}>
      <header className="drawer-header"><div><span className="eyebrow">{detailPortal?.shortLabel ?? 'Traçabilité'}</span><h2>Détail produit</h2></div><button ref={closeButtonRef} type="button" className="icon-button" onClick={() => navigate(closePath)} aria-label="Fermer">×</button></header>
      {error && <div className="notice error" role="alert">{error}</div>}
      {!detail && !error && <div className="drawer-loading"><div className="loader" /><p>Chargement de la fiche…</p></div>}
      {detail && <>
        <section className="detail-hero">
          <div className="detail-visual">
            <ArrivalImage batchId={detail.batch_id} available={detail.photo_available} alt="Étiquette du produit" rotationDegrees={detail.photo_rotation_degrees} baseRotationDegrees={detail.photo_base_rotation_degrees} onOpen={setPhotoViewerUrl} />
          </div>
          <div className="detail-identity">
            <span className="detail-identity-eyebrow">{detailPortal?.shortLabel ?? display(detail.profession_code) ?? 'Produit'} · produit enregistré</span>
            <h3>{productName}</h3>
            {description && <p className="detail-description">{description}</p>}
            {productionMethod && <span className="detail-summary-chip">{productionMethod}</span>}
            {summaryFacts.length > 0 && <dl className={`detail-facts detail-facts-${Math.min(summaryFacts.length, 4)}`}>{summaryFacts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}
            <p className="detail-record-meta">
              <span aria-hidden="true" />
              {[display(store?.name ?? detail.store_code), formatDateTime(detail.recorded_at) ? `Enregistré le ${formatDateTime(detail.recorded_at)}` : null, display(detail.captured_by_user_name)].filter(Boolean).join(' · ')}
            </p>
          </div>
        </section>

        <header className="detail-record-heading">
          <div><span className="eyebrow">Fiche du lot</span><h3>Informations produit</h3></div>
          <span>{fieldCount} information{fieldCount > 1 ? 's' : ''}</span>
        </header>

        <DetailSections sections={detailSections} fields={detail.fields} validation={detail.validation} />
      </>}
    </aside>
    {photoViewerUrl && <ProductPhotoViewer url={photoViewerUrl} rotationDegrees={detail?.photo_rotation_degrees} baseRotationDegrees={detail?.photo_base_rotation_degrees} onClose={() => setPhotoViewerUrl(undefined)} />}
  </div>;
}
