import { describe, expect, it } from 'vitest';

import { arrivalQueryParams } from '../../api';
import { activeArrivalFilterCount, clearArrivalFilters, parseArrivalFilters, updateArrivalFilter, updatePortalFieldFilter } from './filterState';

describe('arrival URL filter state', () => {
  it('reads filters from a shareable URL', () => {
    const filters = parseArrivalFilters(new URLSearchParams('q=saumon&store=PARIS-01&status=registered&from=2026-08-01&to=2026-08-04&view=cards&page=3'));

    expect(filters).toMatchObject({
      query: 'saumon',
      storeCode: 'PARIS-01',
      status: '',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-04',
      view: 'cards',
      page: 3,
      sortBy: 'recorded_at',
      sortDirection: 'desc',
      fieldFilters: [],
    });
  });

  it('resets pagination when a business filter changes', () => {
    const next = updateArrivalFilter(new URLSearchParams('q=thon&page=4&view=cards'), 'supplier', 'Océan Frais');

    expect(next.get('supplier')).toBe('Océan Frais');
    expect(next.has('page')).toBe(false);
    expect(next.get('view')).toBe('cards');
  });

  it('clears filters while preserving the independent search and display preference', () => {
    const next = clearArrivalFilters(new URLSearchParams('q=thon&store=LYON-02&view=cards'));

    expect(next.toString()).toBe('q=thon');
  });

  it('preserves spaces while the search field is being edited and trims only the API query', () => {
    const filters = parseArrivalFilters(new URLSearchParams('q=saumon+atlantique+'));
    const params = arrivalQueryParams('poissonnerie', filters, { limit: 50, offset: 0 });

    expect(filters.query).toBe('saumon atlantique ');
    expect(params.get('q')).toBe('saumon atlantique');
  });

  it('does not count the search as an active filter', () => {
    const searchOnly = parseArrivalFilters(new URLSearchParams('q=saumon+atlantique'));
    const searchAndRemovedStatus = parseArrivalFilters(new URLSearchParams('q=saumon+atlantique&status=registered'));

    expect(activeArrivalFilterCount(searchOnly)).toBe(0);
    expect(activeArrivalFilterCount(searchAndRemovedStatus)).toBe(0);
    expect(searchAndRemovedStatus.status).toBe('');
  });

  it('uses cards as the default display', () => {
    expect(parseArrivalFilters(new URLSearchParams()).view).toBe('cards');
  });

  it('keeps arrival dates as the only date filters exposed by the catalogue', () => {
    const filters = parseArrivalFilters(new URLSearchParams('from=2026-08-01&to=2026-08-04&expiry_from=2026-08-10&expiry_to=2026-08-20'));

    expect(filters.dateFrom).toBe('2026-08-01');
    expect(filters.dateTo).toBe('2026-08-04');
    expect(filters.expiryFrom).toBe('');
    expect(filters.expiryTo).toBe('');
    expect(activeArrivalFilterCount(filters)).toBe(2);
  });

  it('keeps repeated field_filter values in the URL and API query', () => {
    let params = new URLSearchParams('q=saumon&page=3');
    params = updatePortalFieldFilter(params, 'FAO_area', '27');
    params = updatePortalFieldFilter(params, 'production_method', 'wild_caught');
    const filters = parseArrivalFilters(params);
    const apiParams = arrivalQueryParams('poissonnerie', filters, { limit: 50, offset: 0 });

    expect(params.getAll('field_filter')).toEqual(['FAO_area:27', 'production_method:wild_caught']);
    expect(apiParams.getAll('field_filter')).toEqual(['FAO_area:27', 'production_method:wild_caught']);
    expect(params.has('page')).toBe(false);
  });

  it('replaces one métier filter without dropping the other repeated values', () => {
    const current = new URLSearchParams('field_filter=animal_species:bovin&field_filter=cut_name:bavette');
    const next = updatePortalFieldFilter(current, 'animal_species', 'ovin');

    expect(next.getAll('field_filter')).toEqual(['cut_name:bavette', 'animal_species:ovin']);
  });

  it('omits the profession parameter for the admin all-professions view', () => {
    const filters = parseArrivalFilters(new URLSearchParams('q=saumon'));
    const params = arrivalQueryParams(undefined, filters, { limit: 50, offset: 0 });

    expect(params.has('profession')).toBe(false);
    expect(params.get('q')).toBe('saumon');
  });
});
