import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'wouter';

import { getArrivalMetrics, listArrivals } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { portalDefinition } from '../../portals/registry';
import { useScope } from '../../scope/ScopeContext';
import type { Arrival, ArrivalMetrics, ProfessionCode } from '../../types';
import { ArrivalCards, ArrivalTable } from './ArrivalViews';
import { ArrivalDetailPanel } from './ArrivalDetailPanel';
import { FilterPanel } from './FilterPanel';
import { KpiStrip } from './KpiStrip';
import { activeArrivalFilterCount, clearArrivalFilters, parseArrivalFilters, type ScalarArrivalFilterKey, updateArrivalFilter, updatePortalFieldFilter } from './filterState';
import './arrivals.css';

export function ArrivalsPage() {
  const { session } = useAuth();
  const { stores } = useScope();
  const { profession = 'poissonnerie' } = useParams();
  const portal = portalDefinition(profession);
  const [searchParams, setSearchParams] = useSearchParams();
  const serializedFilters = searchParams.toString();
  const filters = useMemo(() => parseArrivalFilters(new URLSearchParams(serializedFilters)), [serializedFilters]);
  const [items, setItems] = useState<Arrival[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<ArrivalMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    if (!session || !portal) return;
    const controller = new AbortController();
    setLoading(true);
    setItems([]);
    setTotal(0);
    listArrivals(session, profession as ProfessionCode, filters, controller.signal)
      .then((page) => {
        setItems(page.items);
        setTotal(page.total ?? page.items.length);
        setError('');
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Chargement impossible');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, portal, profession, session]);

  useEffect(() => {
    if (!session || !portal) return;
    const controller = new AbortController();
    setMetricsLoading(true);
    setMetrics(null);
    getArrivalMetrics(session, profession as ProfessionCode, filters, controller.signal)
      .then(setMetrics)
      .catch(() => { if (!controller.signal.aborted) setMetrics(null); })
      .finally(() => { if (!controller.signal.aborted) setMetricsLoading(false); });
    return () => controller.abort();
  }, [filters, portal, profession, session]);

  if (!portal) return null;
  const activeFilterCount = activeArrivalFilterCount(filters);
  const pageCount = Math.max(1, Math.ceil(total / 50));

  function update(key: ScalarArrivalFilterKey, value: string | number) {
    setSearchParams((current) => updateArrivalFilter(current, key, value), { replace: true });
  }

  function updateFieldFilter(field: string, value: string) {
    setSearchParams((current) => updatePortalFieldFilter(current, field, value), { replace: true });
  }

  return <section className="page-stack" style={{ '--portal-accent': portal.accent } as CSSProperties}>
    <header className="page-header arrivals-heading">
      <div><span className="eyebrow">{portal.label}</span><h1>{portal.labels.pageTitle}</h1><p>{portal.labels.pageDescription}</p></div>
      <div className="heading-stat"><strong>{total}</strong><span>{total > 1 ? portal.labels.recordPlural : portal.labels.recordSingular}</span></div>
    </header>

    <KpiStrip definitions={portal.kpis} metrics={metrics} loading={metricsLoading} />

    <section className="catalog-toolbar" aria-label="Recherche et affichage">
      <label className="search-field"><span className="search-icon" aria-hidden="true">⌕</span><span className="sr-only">Rechercher</span><input type="search" value={filters.query} onChange={(event) => update('query', event.target.value)} placeholder={portal.labels.searchPlaceholder} /></label>
      <button className={`button secondary ${filtersOpen ? 'active' : ''}`} onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen}>Filtres{activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}</button>
      <div className="view-toggle" aria-label="Mode d’affichage">
        <button className={filters.view === 'table' ? 'active' : ''} onClick={() => update('view', 'table')} aria-label="Vue tableau">☷</button>
        <button className={filters.view === 'cards' ? 'active' : ''} onClick={() => update('view', 'cards')} aria-label="Vue cartes">▦</button>
      </div>
    </section>

    {filtersOpen && <FilterPanel portal={portal} filters={filters} stores={stores} onUpdate={update} onFieldFilter={updateFieldFilter} onReset={() => setSearchParams(clearArrivalFilters(searchParams), { replace: true })} />}

    {error && <div className="notice error" role="alert">{error}</div>}
    {loading ? <div className="catalog-loading"><div className="loader" /><p>Chargement des arrivages…</p></div> : <>
      {items.length === 0 && !error
        ? <div className="empty-state"><h2>{portal.labels.emptyTitle}</h2><p>{portal.labels.emptyDescription}</p></div>
        : filters.view === 'cards'
          ? <ArrivalCards arrivals={items} stores={stores} portal={portal} />
          : <ArrivalTable arrivals={items} stores={stores} portal={portal} />}
      {total > 50 && <nav className="pagination" aria-label="Pagination"><button className="button secondary" disabled={filters.page <= 1} onClick={() => update('page', filters.page - 1)}>Précédent</button><span>Page {filters.page} sur {pageCount}</span><button className="button secondary" disabled={filters.page >= pageCount} onClick={() => update('page', filters.page + 1)}>Suivant</button></nav>}
    </>}
    <ArrivalDetailPanel stores={stores} />
  </section>;
}
