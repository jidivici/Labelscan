import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'wouter';

import { ARRIVAL_PAGE_SIZE, listArrivals } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { portalDefinition } from '../../portals/registry';
import { useScope } from '../../scope/ScopeContext';
import type { Arrival } from '../../types';
import { ArrivalCards, ArrivalTable } from './ArrivalViews';
import { ArrivalDetailPanel } from './ArrivalDetailPanel';
import { FilterPanel } from './FilterPanel';
import { activeArrivalFilterCount, clearArrivalFilters, parseArrivalFilters, type ScalarArrivalFilterKey, updateArrivalFilter, updatePortalFieldFilter } from './filterState';
import './arrivals.css';

function paginationItems(currentPage: number, totalPages: number): Array<number | 'ellipsis'> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages: Array<number | 'ellipsis'> = [1];
  if (currentPage > 4) pages.push('ellipsis');
  const start = Math.max(2, currentPage - 1);
  const end = Math.min(totalPages - 1, currentPage + 1);
  for (let page = start; page <= end; page += 1) pages.push(page);
  if (currentPage < totalPages - 3) pages.push('ellipsis');
  pages.push(totalPages);
  return pages;
}

function ArrivalPagination({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
  const pageCount = Math.max(1, Math.ceil(total / ARRIVAL_PAGE_SIZE));
  if (total <= ARRIVAL_PAGE_SIZE) return null;
  const first = ((page - 1) * ARRIVAL_PAGE_SIZE) + 1;
  const last = Math.min(page * ARRIVAL_PAGE_SIZE, total);
  return <nav className="pagination hb-pagination" aria-label="Pagination">
    <span className="pagination-summary">{first}–{last} sur {total}</span>
    <span className="pagination-controls">
      <button type="button" className="pagination-button pagination-arrow" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Page précédente">‹</button>
      {paginationItems(page, pageCount).map((item, index) => item === 'ellipsis'
        ? <span className="pagination-ellipsis" key={`ellipsis-${index}`}>…</span>
        : <button type="button" className={`pagination-button ${item === page ? 'is-current' : ''}`} aria-current={item === page ? 'page' : undefined} aria-label={`Page ${item}`} onClick={() => onChange(item)} key={item}>{item}</button>)}
      <button type="button" className="pagination-button pagination-arrow" disabled={page >= pageCount} onClick={() => onChange(page + 1)} aria-label="Page suivante">›</button>
    </span>
  </nav>;
}

export function ArrivalsPage() {
  const { session } = useAuth();
  const { stores } = useScope();
  const { profession: routeProfession } = useParams();
  const [location] = useLocation();
  const profession = routeProfession ?? (location.includes('/portails/tous/') ? 'tous' : 'poissonnerie');
  const allProfessions = profession === 'tous';
  const portal = portalDefinition(profession);
  const selectedProfession = portal?.code;
  const [searchParams, setSearchParams] = useSearchParams();
  const serializedFilters = searchParams.toString();
  const filters = useMemo(() => parseArrivalFilters(new URLSearchParams(serializedFilters)), [serializedFilters]);
  const [items, setItems] = useState<Arrival[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    if (!session || (!portal && !allProfessions)) return;
    const controller = new AbortController();
    setLoading(true);
    setItems([]);
    setTotal(0);
    listArrivals(session, selectedProfession, filters, controller.signal)
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
  }, [allProfessions, filters, portal, selectedProfession, session]);

  if (!portal && !allProfessions) return null;
  const activeFilterCount = activeArrivalFilterCount(filters);
  const accent = portal?.accent ?? '#146f65';
  const title = portal?.labels.pageTitle ?? 'Tous les arrivages';
  const recordSingular = portal?.labels.recordSingular ?? 'article';
  const recordPlural = portal?.labels.recordPlural ?? 'articles';

  function update(key: ScalarArrivalFilterKey, value: string | number) {
    setSearchParams((current) => updateArrivalFilter(current, key, value), { replace: true });
  }

  function updateFieldFilter(field: string, value: string) {
    setSearchParams((current) => updatePortalFieldFilter(current, field, value), { replace: true });
  }

  function updateDateRange(
    fromKey: 'dateFrom' | 'expiryFrom',
    toKey: 'dateTo' | 'expiryTo',
    from: string,
    to: string,
  ) {
    setSearchParams((current) => {
      const withFrom = updateArrivalFilter(current, fromKey, from);
      return updateArrivalFilter(withFrom, toKey, to);
    }, { replace: true });
  }

  function resetFilters() {
    setSearchParams(clearArrivalFilters(new URLSearchParams(serializedFilters)), { replace: true });
  }

  return <section className="page-stack" style={{ '--portal-accent': accent } as CSSProperties}>
    <header className="page-header arrivals-heading">
      <div><span className="eyebrow">{portal?.label ?? 'Tous les métiers'}</span><h1>{title}</h1></div>
      <div className="heading-stat"><strong>{total.toLocaleString('fr-FR')}</strong><span>{total > 1 ? recordPlural : recordSingular}</span></div>
    </header>

    <section className="catalog-toolbar" aria-label="Recherche et affichage">
      <label className="search-field"><span className="search-icon" aria-hidden="true">⌕</span><span className="sr-only">Rechercher</span><input type="search" value={filters.query} onChange={(event) => update('query', event.target.value)} placeholder={portal?.labels.searchPlaceholder ?? 'Produit, lot, fournisseur, GTIN…'} /></label>
      <button type="button" className={`button secondary ${filtersOpen ? 'active' : ''}`} onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen}>Filtres{activeFilterCount > 0 && <span className="filter-count">{activeFilterCount}</span>}</button>
      <div className="view-toggle" aria-label="Mode d’affichage">
        <button type="button" className={filters.view === 'cards' ? 'active' : ''} onClick={() => update('view', 'cards')} aria-label="Vue cartes" aria-pressed={filters.view === 'cards'}>▦ <span>Cartes</span></button>
        <button type="button" className={filters.view === 'table' ? 'active' : ''} onClick={() => update('view', 'table')} aria-label="Vue liste" aria-pressed={filters.view === 'table'}>☷ <span>Liste</span></button>
      </div>
    </section>

    {filtersOpen && <FilterPanel portal={portal} filters={filters} stores={stores} onUpdate={update} onDateRangeChange={updateDateRange} onFieldFilter={updateFieldFilter} onReset={resetFilters} />}

    {error && <div className="notice error" role="alert">{error}</div>}
    {loading ? <div className="catalog-loading"><div className="loader" /><p>Chargement des arrivages…</p></div> : <>
      {items.length === 0 && !error
        ? <div className="empty-state"><h2>{portal?.labels.emptyTitle ?? 'Aucun arrivage trouvé'}</h2><p>{portal?.labels.emptyDescription ?? 'Modifiez vos filtres ou enregistrez un nouvel article.'}</p></div>
        : filters.view === 'cards'
          ? <ArrivalCards arrivals={items} portal={portal} />
          : <ArrivalTable arrivals={items} stores={stores} portal={portal} />}
      <ArrivalPagination page={filters.page} total={total} onChange={(page) => update('page', page)} />
    </>}
    <ArrivalDetailPanel stores={stores} />
  </section>;
}
