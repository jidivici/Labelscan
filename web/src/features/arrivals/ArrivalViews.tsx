import type { ReactNode } from 'react';
import { Link, useParams } from 'wouter';

import type { PortalDefinition } from '../../portals/registry';
import type { PortalSecondaryColumn } from '../../portals/types';
import type { Arrival, Store } from '../../types';
import { ArrivalImage } from './ArrivalImage';

const STATUS_LABELS: Record<string, string> = {
  registered: 'Enregistré',
  flagged: 'Signalé',
};

function storeLabel(stores: Store[], code: string | null): string {
  if (!code) return 'Magasin non renseigné';
  return stores.find((store) => store.code === code)?.name ?? code;
}

function date(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(value));
}

function StatusBadge({ value }: { value: string }) {
  const warning = value === 'flagged';
  return <span className={`status-badge ${warning ? 'warning' : ''}`}>{STATUS_LABELS[value] ?? value}</span>;
}

function secondaryValue(arrival: Arrival, column: PortalSecondaryColumn): ReactNode {
  const raw = arrival[column.source];
  if (raw === null || raw === undefined || raw === '') return <span className="secondary-value missing">—</span>;
  if (column.format === 'date') return <span className="secondary-value">{date(String(raw))}</span>;
  if (column.format === 'percentage') {
    const numeric = Math.max(0, Math.min(100, Number(raw)));
    return <span className="completeness-value"><span className="completeness-track"><span style={{ width: `${numeric}%` }} /></span>{numeric} %</span>;
  }
  if (column.format === 'alert') {
    const labels: Record<string, string> = { open: 'Ouverte', acknowledged: 'Acquittée', resolved: 'Résolue' };
    return <span className={`status-badge ${raw === 'open' ? 'warning' : ''}`}>{labels[String(raw)] ?? String(raw)}</span>;
  }
  return <span className="secondary-value">{String(raw)}</span>;
}

export function ArrivalTable({ arrivals, stores, portal }: { arrivals: Arrival[]; stores: Store[]; portal: PortalDefinition }) {
  const { organizationSlug = 'labelscan', profession = 'poissonnerie' } = useParams();
  return <div className="data-panel table-panel"><div className="table-scroll"><table>
    <thead><tr><th>Produit</th><th>Lot</th><th>Magasin</th><th>Fournisseur</th>{portal.secondaryColumns.map((column) => <th key={column.key}>{column.label}</th>)}<th>Statut</th><th>Enregistrement</th><th><span className="sr-only">Détail</span></th></tr></thead>
    <tbody>{arrivals.map((arrival) => <tr key={arrival.batch_id}>
      <td><div className="product-cell"><ArrivalImage batchId={arrival.batch_id} available={arrival.photo_available} /><span><strong>{arrival.product_name || 'Produit sans désignation'}</strong><small>{arrival.scientific_name || arrival.gtin || 'Information à compléter'}</small></span></div></td>
      <td><span className="lot-code">{arrival.lot_code || '—'}</span></td>
      <td>{storeLabel(stores, arrival.store_code)}</td>
      <td>{arrival.supplier_name || '—'}</td>
      {portal.secondaryColumns.map((column) => <td key={column.key}>{secondaryValue(arrival, column)}</td>)}
      <td><StatusBadge value={arrival.status} /></td>
      <td>{date(arrival.recorded_at)}</td>
      <td><Link className="row-action" to={`/o/${organizationSlug}/portails/${profession}/arrivages/${arrival.batch_id}`} aria-label={`Ouvrir ${arrival.product_name ?? 'le produit'}`}>→</Link></td>
    </tr>)}</tbody>
  </table></div></div>;
}

export function ArrivalCards({ arrivals, stores, portal }: { arrivals: Arrival[]; stores: Store[]; portal: PortalDefinition }) {
  const { organizationSlug = 'labelscan', profession = 'poissonnerie' } = useParams();
  return <div className="arrival-grid">{arrivals.map((arrival) => <Link className="arrival-card" to={`/o/${organizationSlug}/portails/${profession}/arrivages/${arrival.batch_id}`} key={arrival.batch_id}>
    <ArrivalImage batchId={arrival.batch_id} available={arrival.photo_available} alt={arrival.product_name ?? ''} />
    <span className="arrival-card-body">
      <span className="card-status"><StatusBadge value={arrival.status} /><small>{arrival.completeness !== undefined ? `${arrival.completeness} % complet` : date(arrival.recorded_at)}</small></span>
      <strong>{arrival.product_name || 'Produit sans désignation'}</strong>
      <em>{arrival.scientific_name || arrival.supplier_name || 'Information à compléter'}</em>
      <span className="card-meta"><span>Lot {arrival.lot_code || '—'}</span><span>{storeLabel(stores, arrival.store_code)}</span>{arrival.alert_state === 'open' && <span>Alerte ouverte</span>}</span>
    </span>
  </Link>)}</div>;
}
