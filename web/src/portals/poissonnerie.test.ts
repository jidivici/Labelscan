import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { arrivalQueryParams } from '../api';
import { DetailSections } from '../features/arrivals/DetailSections';
import { parseArrivalFilters, updatePortalFieldFilter } from '../features/arrivals/filterState';
import { poissonneriePortal } from './poissonnerie';

const CANONICAL_FIELDS = [
  'commercial_designation',
  'producer_name',
  'reseller_brand',
  'gtin',
  'scientific_name',
  'FAO_area',
  'production_method',
  'fishing_gear_or_farming_method',
  'batch_number',
  'origin_country',
  'health_mark',
  'packaging_date',
  'expiry_date',
  'storage_temperature',
  'allergens',
  'weight',
] as const;

const LEGACY_FIELDS = ['product_name', 'supplier_name'] as const;

const FILTER_VALUES: Record<string, string> = {
  commercial_designation: 'saumon atlantique',
  scientific_name: 'Salmo salar',
  FAO_area: '27',
  production_method: 'farmed',
  fishing_gear_or_farming_method: 'cage marine',
};

describe('poissonneriePortal', () => {
  it('exposes the arrivals page labels', () => {
    expect(poissonneriePortal.labels).toMatchObject({
      pageTitle: 'Tableau de bord poissonnerie',
      emptyTitle: 'Aucun arrivage de produits de la mer',
      recordSingular: 'arrivage',
      recordPlural: 'arrivages',
    });
    expect(poissonneriePortal.labels.pageDescription).toContain('traçabilité');
    expect(poissonneriePortal.labels.emptyDescription).toContain('filtres actifs');
  });

  it('keeps the 16 canonical métier fields unique, complete and ordered like mobile', () => {
    const configuredFields = poissonneriePortal.detailSections.flatMap(({ fields }) =>
      fields.map(({ key }) => key),
    );
    const canonicalConfiguredFields = configuredFields.filter((field) =>
      (CANONICAL_FIELDS as readonly string[]).includes(field),
    );

    expect(canonicalConfiguredFields).toEqual([...CANONICAL_FIELDS]);
    expect(new Set(canonicalConfiguredFields).size).toBe(16);
  });

  it('renders historical designation and supplier values from legacy records', () => {
    render(
      createElement(DetailSections, {
        sections: poissonneriePortal.detailSections,
        fields: {
          product_name: 'Cabillaud historique',
          supplier_name: 'Criée des anciens lots',
        },
      }),
    );

    expect(screen.getByText('Informations historiques')).toBeInTheDocument();
    expect(screen.getByText('Cabillaud historique')).toBeInTheDocument();
    expect(screen.getByText('Criée des anciens lots')).toBeInTheDocument();
    expect(screen.queryByText('Non renseigné')).not.toBeInTheDocument();
    expect(screen.queryByText('Producteur')).not.toBeInTheDocument();
    expect(
      poissonneriePortal.detailSections
        .flatMap(({ fields }) => fields.map(({ key }) => key))
        .filter((field) => (LEGACY_FIELDS as readonly string[]).includes(field)),
    ).toEqual(LEGACY_FIELDS);
  });

  it('persists every métier filter and forwards it to the server query', () => {
    expect(poissonneriePortal.fieldFilters.map(({ field }) => field)).toEqual(Object.keys(FILTER_VALUES));

    let searchParams = new URLSearchParams('view=cards');
    for (const { field } of poissonneriePortal.fieldFilters) {
      searchParams = updatePortalFieldFilter(searchParams, field, FILTER_VALUES[field]);
    }

    const parsedFilters = parseArrivalFilters(searchParams);
    const apiParams = arrivalQueryParams('poissonnerie', parsedFilters, { limit: 50, offset: 0 });
    const expectedFieldFilters = Object.entries(FILTER_VALUES).map(([field, value]) => `${field}:${value}`);

    expect(searchParams.get('view')).toBe('cards');
    expect(searchParams.getAll('field_filter')).toEqual(expectedFieldFilters);
    expect(parsedFilters.fieldFilters).toEqual(
      Object.entries(FILTER_VALUES).map(([field, value]) => ({ field, value })),
    );
    expect(apiParams.getAll('field_filter')).toEqual(expectedFieldFilters);
  });

  it('uses operational secondary columns supported by the shared table', () => {
    expect(poissonneriePortal.secondaryColumns).toEqual([
      { key: 'scientific-name', label: 'Nom scientifique', source: 'scientific_name' },
      { key: 'fao-area', label: 'Zone FAO', source: 'fao_area_code' },
      { key: 'use-by', label: 'À consommer avant', source: 'use_by', format: 'date' },
    ]);
  });
});
