import type { ReactNode } from 'react';
import { Link, useLocation, useParams, useSearch } from 'wouter';

import type { PortalDefinition } from '../../portals/registry';
import { portalDefinition } from '../../portals/registry';
import type { PortalSecondaryColumn } from '../../portals/types';
import type { Arrival, Store } from '../../types';
import { ArrivalImage } from './ArrivalImage';

function storeLabel(stores: Store[], code: string | null): string | null {
  if (!code?.trim()) return null;
  return stores.find((store) => store.code === code)?.name ?? code;
}

function date(value: string | null): string | null {
  if (!value?.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(parsed);
}

function professionLabel(arrival: Arrival): string | null {
  return portalDefinition(arrival.profession_code)?.shortLabel ?? null;
}

function productTitle(arrival: Arrival): string {
  return arrival.product_name?.trim()
    || (arrival.lot_code?.trim() ? `Lot ${arrival.lot_code}` : '')
    || arrival.gtin?.trim()
    || arrival.batch_id;
}

function productionMethodLabel(value: string | null): string | null {
  if (!value?.trim()) return null;
  if (value === 'wild_caught') return 'Pêche sauvage';
  if (value === 'farmed') return 'Élevage';
  return value;
}

function labeledChip(label: string, value: string): string {
  return value.toLocaleLowerCase('fr-FR').startsWith(`${label.toLocaleLowerCase('fr-FR')} `) ? value : `${label} ${value}`;
}

function secondaryValue(arrival: Arrival, column: PortalSecondaryColumn): ReactNode {
  const raw = arrival[column.source];
  if (raw === null || raw === undefined || raw === '') return null;
  if (column.format === 'date') return <span className="secondary-value">{date(String(raw))}</span>;
  return <span className="secondary-value">{String(raw)}</span>;
}

export function ArrivalTable({ arrivals, stores, portal }: { arrivals: Arrival[]; stores: Store[]; portal: PortalDefinition | null }) {
  const { organizationSlug = 'labelscan', profession: routeProfession } = useParams();
  const [location, navigate] = useLocation();
  const profession = routeProfession ?? (location.includes('/portails/tous/') ? 'tous' : 'poissonnerie');
  const search = useSearch();
  const query = search ? `?${search}` : '';
  const secondaryColumns = portal?.secondaryColumns.filter((column) => arrivals.some((arrival) => {
    const value = arrival[column.source];
    return value !== null && value !== undefined && value !== '';
  })) ?? [];
  const showProfession = !portal && arrivals.some((arrival) => professionLabel(arrival));
  const showLot = arrivals.some((arrival) => arrival.lot_code?.trim());
  const showStore = arrivals.some((arrival) => storeLabel(stores, arrival.store_code));
  const showSupplier = arrivals.some((arrival) => arrival.supplier_name?.trim());
  return <div className="data-panel table-panel"><div className="table-scroll"><table>
    <thead><tr><th>Produit</th>{showProfession && <th>Métier</th>}{showLot && <th>Lot</th>}{showStore && <th>Magasin</th>}{showSupplier && <th>Fournisseur</th>}{secondaryColumns.map((column) => <th key={column.key}>{column.label}</th>)}<th>Enregistrement</th><th><span className="sr-only">Détail</span></th></tr></thead>
    <tbody>{arrivals.map((arrival) => {
      const detailPath = `/o/${organizationSlug}/portails/${profession}/arrivages/${arrival.batch_id}${query}`;
      const openDetail = () => navigate(detailPath);
      return <tr key={arrival.batch_id} className="arrival-row" role="link" tabIndex={0} aria-label={`Voir ${productTitle(arrival)}`} onClick={openDetail} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(); } }}>
      <td><div className="product-cell"><ArrivalImage batchId={arrival.batch_id} available={arrival.photo_available} /><span><strong>{productTitle(arrival)}</strong>{(arrival.scientific_name || arrival.gtin) && <small>{arrival.scientific_name || arrival.gtin}</small>}</span></div></td>
      {showProfession && <td>{professionLabel(arrival) && <span className="profession-badge">{professionLabel(arrival)}</span>}</td>}
      {showLot && <td>{arrival.lot_code?.trim() && <span className="lot-code">{arrival.lot_code}</span>}</td>}
      {showStore && <td>{storeLabel(stores, arrival.store_code)}</td>}
      {showSupplier && <td>{arrival.supplier_name}</td>}
      {secondaryColumns.map((column) => <td key={column.key}>{secondaryValue(arrival, column)}</td>)}
      <td>{date(arrival.recorded_at)}</td>
      <td><Link className="row-action" to={detailPath} onClick={(event) => event.stopPropagation()} aria-label={`Ouvrir ${productTitle(arrival)}`}>→</Link></td>
    </tr>;
    })}</tbody>
  </table></div></div>;
}

export function ArrivalCards({ arrivals, portal }: { arrivals: Arrival[]; portal: PortalDefinition | null }) {
  const { organizationSlug = 'labelscan', profession: routeProfession } = useParams();
  const [location] = useLocation();
  const profession = routeProfession ?? (location.includes('/portails/tous/') ? 'tous' : 'poissonnerie');
  const search = useSearch();
  const query = search ? `?${search}` : '';
  return <div className="arrival-grid">{arrivals.map((arrival) => {
    const description = [arrival.scientific_name?.trim(), arrival.supplier_name?.trim(), productionMethodLabel(arrival.production_method)]
      .filter(Boolean)
      .join(' · ');
    const chips = [
      arrival.lot_code?.trim() ? labeledChip('Lot', arrival.lot_code.trim()) : null,
      arrival.fao_area_code?.trim() ? labeledChip('FAO', arrival.fao_area_code.trim()) : null,
    ].filter((item): item is string => Boolean(item));
    const professionName = professionLabel(arrival);
    return <Link className="arrival-card" to={`/o/${organizationSlug}/portails/${profession}/arrivages/${arrival.batch_id}${query}`} key={arrival.batch_id}>
    <span className="arrival-card-visual">
      <ArrivalImage batchId={arrival.batch_id} available={arrival.photo_available} alt={arrival.product_name ?? ''} />
    </span>
    <span className="arrival-card-body">
      <span className="card-heading"><strong>{productTitle(arrival)}</strong></span>
      {description && <em>{description}</em>}
      {chips.length > 0 && <span className="card-chip-row">{chips.map((chip) => <span key={chip}>{chip}</span>)}</span>}
      <span className="card-footer"><span>{date(arrival.recorded_at) ? `Enregistré le ${date(arrival.recorded_at)}` : 'Enregistré'}</span>{!portal && professionName && <span className="profession-badge">{professionName}</span>}<span className="card-chevron" aria-hidden="true">›</span></span>
    </span>
  </Link>;
  })}</div>;
}
