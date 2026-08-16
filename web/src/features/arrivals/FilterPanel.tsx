import type { PortalDefinition } from '../../portals/registry';
import type { ArrivalFilters, Store } from '../../types';
import type { ScalarArrivalFilterKey } from './filterState';
import { DateRangeCalendar } from './DateRangeCalendar';

interface FilterPanelProps {
  portal: PortalDefinition | null;
  filters: ArrivalFilters;
  stores: Store[];
  onUpdate: (key: ScalarArrivalFilterKey, value: string | number) => void;
  onDateRangeChange: (from: string, to: string) => void;
  onFieldFilter: (field: string, value: string) => void;
  onReset: () => void;
}

function fieldValue(filters: ArrivalFilters, field: string): string {
  return filters.fieldFilters.find((filter) => filter.field === field)?.value ?? '';
}

export function FilterPanel({ portal, filters, stores, onUpdate, onDateRangeChange, onFieldFilter, onReset }: FilterPanelProps) {
  return <section className="advanced-filter-panel" aria-label={portal ? `Filtres ${portal.label}` : 'Filtres tous les métiers'}>
    <div className="filter-group">
      <div className="filter-panel-topbar">
        <strong>Filtres LabelScan</strong>
        <button type="button" className="button text small" onClick={onReset}>Réinitialiser tous les filtres</button>
      </div>
      <div className="filter-grid">
        {stores.length > 1 && <label className="field"><span>Magasin</span><select value={filters.storeCode} onChange={(event) => onUpdate('storeCode', event.target.value)}><option value="">Tous les magasins autorisés</option>{stores.map((store) => <option value={store.code} key={store.code}>{store.name}</option>)}</select></label>}
      </div>
    </div>

    <div className="filter-group">
      <div className="filter-group-heading"><strong>Références et dates</strong><span>Filtres serveur</span></div>
      <div className="filter-grid">
        <label className="field"><span>Fournisseur</span><input value={filters.supplier} onChange={(event) => onUpdate('supplier', event.target.value)} placeholder="Nom du fournisseur" /></label>
        <label className="field"><span>Lot</span><input value={filters.lotCode} onChange={(event) => onUpdate('lotCode', event.target.value)} placeholder="Numéro de lot" /></label>
        <label className="field"><span>GTIN</span><input value={filters.gtin} onChange={(event) => onUpdate('gtin', event.target.value)} placeholder="Code GTIN" /></label>
        <DateRangeCalendar label="Arrivage" from={filters.dateFrom} to={filters.dateTo} disableFuture onChange={onDateRangeChange} />
      </div>
    </div>

    {portal && <div className="filter-group portal-filter-group">
      <div className="filter-group-heading"><strong>Critères {portal.shortLabel.toLocaleLowerCase('fr-FR')}</strong><span>Champs métier</span></div>
      <div className="filter-grid">{portal.fieldFilters.map((definition) =>
        <label className="field" key={definition.field}><span>{definition.label}</span>{definition.type === 'select'
          ? <select value={fieldValue(filters, definition.field)} onChange={(event) => onFieldFilter(definition.field, event.target.value)}><option value="">Tous</option>{definition.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
          : <input value={fieldValue(filters, definition.field)} onChange={(event) => onFieldFilter(definition.field, event.target.value)} placeholder={definition.placeholder} />}</label>,
      )}</div>
    </div>}

    {!portal && <div className="all-professions-filter-note">Les critères communs s’appliquent à tous les métiers. Sélectionnez un métier dans le menu pour afficher ses filtres spécialisés.</div>}

    <div className="filter-footer">
      <div className="sort-controls">
        <label className="field"><span>Trier par</span><select value={filters.sortBy} onChange={(event) => onUpdate('sortBy', event.target.value)}><option value="recorded_at">Date d’enregistrement</option><option value="expiry_date">Date d’expiration</option><option value="product_name">Produit</option><option value="supplier">Fournisseur</option><option value="lot_code">Lot</option></select></label>
        <label className="field"><span>Ordre</span><select value={filters.sortDirection} onChange={(event) => onUpdate('sortDirection', event.target.value)}><option value="desc">Décroissant</option><option value="asc">Croissant</option></select></label>
      </div>
    </div>
  </section>;
}
