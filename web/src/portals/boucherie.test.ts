import { describe, expect, it } from 'vitest';

import { arrivalQueryParams } from '../api';
import { parseArrivalFilters, updatePortalFieldFilter } from '../features/arrivals/filterState';
import { boucheriePortal } from './boucherie';

const COMMON_FIELDS = [
  'commercial_designation',
  'producer_name',
  'reseller_brand',
  'batch_number',
  'origin_country',
  'expiry_date',
  'packaging_date',
  'storage_temperature',
  'allergens',
  'health_mark',
  'weight',
  'price',
  'gtin',
] as const;

const BOUCHERIE_FIELDS = [
  'animal_species',
  'animal_category',
  'cut_name',
  'birth_country',
  'rearing_country',
  'slaughter_country',
  'cutting_country',
  'slaughterhouse_approval',
  'cutting_plant_approval',
] as const;

const BOUCHERIE_FILTERS = [
  'animal_species',
  'animal_category',
  'cut_name',
  'origin_country',
  'birth_country',
  'rearing_country',
  'slaughter_country',
  'cutting_country',
  'slaughterhouse_approval',
  'cutting_plant_approval',
] as const;

const POISSONNERIE_FIELDS = [
  'scientific_name',
  'FAO_area',
  'production_method',
  'fishing_gear_or_farming_method',
] as const;

describe('boucherie portal', () => {
  it('exposes the complete version 1 detail contract for the trade', () => {
    const fields = boucheriePortal.detailSections.flatMap((section) => section.fields.map((field) => field.key));

    expect(fields).toHaveLength(22);
    expect(new Set(fields).size).toBe(22);
    expect(new Set(fields)).toEqual(new Set([...COMMON_FIELDS, ...BOUCHERIE_FIELDS]));
    expect(fields).not.toEqual(expect.arrayContaining([...POISSONNERIE_FIELDS]));
  });

  it('declares all professional filters and preserves them in shareable and server URLs', () => {
    expect(boucheriePortal.fieldFilters.map((filter) => filter.field)).toEqual(BOUCHERIE_FILTERS);

    const values: Record<(typeof BOUCHERIE_FILTERS)[number], string> = {
      animal_species: 'bovin',
      animal_category: 'génisse',
      cut_name: 'bavette',
      origin_country: 'France',
      birth_country: 'France',
      rearing_country: 'France',
      slaughter_country: 'France',
      cutting_country: 'France',
      slaughterhouse_approval: 'FR 12.345.678 CE',
      cutting_plant_approval: 'FR 12.345.679 CE',
    };
    let pageParams = new URLSearchParams('page=4');
    for (const field of BOUCHERIE_FILTERS) {
      pageParams = updatePortalFieldFilter(pageParams, field, values[field]);
    }

    const expected = BOUCHERIE_FILTERS.map((field) => `${field}:${values[field]}`);
    const filters = parseArrivalFilters(pageParams);
    const serverParams = arrivalQueryParams('boucherie', filters, { limit: 50, offset: 0 });

    expect(pageParams.getAll('field_filter')).toEqual(expected);
    expect(serverParams.getAll('field_filter')).toEqual(expected);
    expect(serverParams.get('profession')).toBe('boucherie');
    expect(pageParams.has('page')).toBe(false);
  });

  it('uses professional column and empty-state language', () => {
    expect(boucheriePortal.secondaryColumns.map((column) => [column.source, column.label])).toEqual([
      ['use_by', 'Date limite de consommation'],
    ]);
    expect(boucheriePortal.labels).toMatchObject({
      pageTitle: 'Réceptions boucherie',
      emptyTitle: 'Aucun lot de viande à afficher',
      recordSingular: 'lot de viande',
      recordPlural: 'lots de viande',
    });
  });

  it('does not leak poissonnerie filters into the boucherie workspace', () => {
    const filters = boucheriePortal.fieldFilters.map((filter) => filter.field);

    expect(filters).not.toEqual(expect.arrayContaining([...POISSONNERIE_FIELDS]));
  });
});
