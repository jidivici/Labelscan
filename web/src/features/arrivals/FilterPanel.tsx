import type { PortalDefinition } from '../../portals/registry';
import type { ArrivalFilters, Store } from '../../types';
import type { ScalarArrivalFilterKey } from './filterState';

interface FilterPanelProps {
  portal: PortalDefinition;
  filters: ArrivalFilters;
  stores: Store[];
  onUpdate: (key: ScalarArrivalFilterKey, value: string | number) => void;
  onFieldFilter: (field: string, value: string) => void;
  onReset: () => void;
}

function fieldValue(filters: ArrivalFilters, field: string): string {
  return filters.fieldFilters.find((filter) => filter.field === field)?.value ?? '';
}

export function FilterPanel({ portal, filters, stores, onUpdate, onFieldFilter, onReset }: FilterPanelProps) {
  return <section className="advanced-filter-panel" aria-label={`Filtres ${portal.label}`}>
    <div className="filter-group">
      <div className="filter-group-heading"><strong>Périmètre et statut</strong><span>Critères communs</span></div>
      <div className="filter-grid">
        <label className="field"><span>Magasin</span><select value={filters.storeCode} onChange={(event) => onUpdate('storeCode', event.target.value)}><option value="">Tous les magasins autorisés</option>{stores.map((store) => <option value={store.code} key={store.code}>{store.name}</option>)}</select></label>
        <label className="field"><span>Statut</span><select value={filters.status} onChange={(event) => onUpdate('status', event.target.value)}><option value="">Tous les statuts</option><option value="registered">Enregistrés</option><option value="flagged">Signalés</option></select></label>
        <label className="field"><span>Alertes</span><select value={filters.alertState} onChange={(event) => onUpdate('alertState', event.target.value)}><option value="">Tous les états</option><option value="open">Ouvertes</option><option value="acknowledged">Acquittées</option><option value="resolved">Résolues</option></select></label>
        <label className="field"><span>Complétude minimale</span><select value={filters.completenessMin} onChange={(event) => onUpdate('completenessMin', event.target.value)}><option value="">Toutes</option><option value="50">50 %</option><option value="80">80 %</option><option value="100">100 %</option></select></label>
      </div>
    </div>

    <div className="filter-group">
      <div className="filter-group-heading"><strong>Références et dates</strong><span>Filtres serveur</span></div>
      <div className="filter-grid">
        <label className="field"><span>Fournisseur</span><input value={filters.supplier} onChange={(event) => onUpdate('supplier', event.target.value)} placeholder="Nom du fournisseur" /></label>
        <label className="field"><span>Lot</span><input value={filters.lotCode} onChange={(event) => onUpdate('lotCode', event.target.value)} placeholder="Numéro de lot" /></label>
        <label className="field"><span>GTIN</span><input value={filters.gtin} onChange={(event) => onUpdate('gtin', event.target.value)} placeholder="Code GTIN" /></label>
        <label className="field"><span>Enregistré du</span><input type="date" value={filters.dateFrom} onChange={(event) => onUpdate('dateFrom', event.target.value)} /></label>
        <label className="field"><span>Enregistré au</span><input type="date" value={filters.dateTo} onChange={(event) => onUpdate('dateTo', event.target.value)} /></label>
        <label className="field"><span>Expiration du</span><input type="date" value={filters.expiryFrom} onChange={(event) => onUpdate('expiryFrom', event.target.value)} /></label>
        <label className="field"><span>Expiration au</span><input type="date" value={filters.expiryTo} onChange={(event) => onUpdate('expiryTo', event.target.value)} /></label>
      </div>
    </div>

    <div className="filter-group portal-filter-group">
      <div className="filter-group-heading"><strong>Critères {portal.shortLabel.toLocaleLowerCase('fr-FR')}</strong><span>Champs métier</span></div>
      <div className="filter-grid">{portal.fieldFilters.map((definition) =>
        <label className="field" key={definition.field}><span>{definition.label}</span>{definition.type === 'select'
          ? <select value={fieldValue(filters, definition.field)} onChange={(event) => onFieldFilter(definition.field, event.target.value)}><option value="">Tous</option>{definition.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
          : <input value={fieldValue(filters, definition.field)} onChange={(event) => onFieldFilter(definition.field, event.target.value)} placeholder={definition.placeholder} />}</label>,
      )}</div>
    </div>

    <div className="filter-footer">
      <div className="sort-controls">
        <label className="field"><span>Trier par</span><select value={filters.sortBy} onChange={(event) => onUpdate('sortBy', event.target.value)}><option value="recorded_at">Date d’enregistrement</option><option value="expiry_date">Date d’expiration</option><option value="product_name">Produit</option><option value="supplier">Fournisseur</option><option value="lot_code">Lot</option><option value="completeness">Complétude</option><option value="status">Statut</option></select></label>
        <label className="field"><span>Ordre</span><select value={filters.sortDirection} onChange={(event) => onUpdate('sortDirection', event.target.value)}><option value="desc">Décroissant</option><option value="asc">Croissant</option></select></label>
      </div>
      <button className="button text" onClick={onReset}>Réinitialiser tous les filtres</button>
    </div>
  </section>;
}
