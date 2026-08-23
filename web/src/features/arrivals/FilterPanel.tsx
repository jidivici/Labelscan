import type { PortalDefinition } from '../../portals/registry';
import type { ArrivalFilters, Store } from '../../types';
import { DropdownSelect } from '../../components/DropdownSelect';
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
        {stores.length > 1 && <label className="field"><span>Magasin</span><DropdownSelect
          className="filter-dropdown"
          options={[{ value: '', label: 'Tous les magasins autorisés' }, ...stores.map((store) => ({ value: store.code, label: store.name }))]}
          selected={filters.storeCode}
          onChange={(value) => onUpdate('storeCode', value)}
          ariaLabel="Magasin"
        /></label>}
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
          ? <DropdownSelect
              className="filter-dropdown"
              options={[{ value: '', label: 'Tous' }, ...(definition.options ?? [])]}
              selected={fieldValue(filters, definition.field)}
              onChange={(value) => onFieldFilter(definition.field, value)}
              ariaLabel={definition.label}
            />
          : <input value={fieldValue(filters, definition.field)} onChange={(event) => onFieldFilter(definition.field, event.target.value)} placeholder={definition.placeholder} />}</label>,
      )}</div>
    </div>}

    {!portal && <div className="all-professions-filter-note">Les critères communs s’appliquent à tous les métiers. Sélectionnez un métier dans le menu pour afficher ses filtres spécialisés.</div>}

    <div className="filter-footer">
      <div className="sort-controls">
        <label className="field"><span>Trier par</span><DropdownSelect
          className="filter-dropdown"
          options={[
            { value: 'recorded_at', label: 'Date d’enregistrement' },
            { value: 'expiry_date', label: 'Date d’expiration' },
            { value: 'product_name', label: 'Produit' },
            { value: 'supplier', label: 'Fournisseur' },
            { value: 'lot_code', label: 'Lot' },
          ]}
          selected={filters.sortBy}
          onChange={(value) => onUpdate('sortBy', value)}
          ariaLabel="Trier par"
        /></label>
        <label className="field"><span>Ordre</span><DropdownSelect
          className="filter-dropdown"
          options={[{ value: 'desc', label: 'Décroissant' }, { value: 'asc', label: 'Croissant' }]}
          selected={filters.sortDirection}
          onChange={(value) => onUpdate('sortDirection', value)}
          ariaLabel="Ordre"
        /></label>
      </div>
    </div>
  </section>;
}
