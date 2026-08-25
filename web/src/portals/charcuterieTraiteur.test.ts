import { describe, expect, it } from 'vitest';

import { arrivalQueryParams } from '../api';
import type { ArrivalFilters } from '../types';
import { charcuterieTraiteurPortal } from './charcuterieTraiteur';

const PROFILE_FIELDS = [
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
  'gtin',
  'product_family',
  'manufacturer_name',
  'ingredients',
  'additives',
  'preparation_date',
  'conditioning_type',
  'storage_mode',
  'use_instructions',
  'reheating_instructions',
] as const;

const PORTAL_FILTER_FIELDS = [
  'product_family',
  'manufacturer_name',
  'allergens',
  'conditioning_type',
  'preparation_date',
  'storage_temperature',
  'storage_mode',
  'ingredients',
  'additives',
] as const;

describe('charcuterieTraiteurPortal', () => {
  it('exposes every field from the 21-field V2 extraction profile exactly once', () => {
    const configuredFields = charcuterieTraiteurPortal.detailSections.flatMap((section) =>
      section.fields.map((field) => field.key),
    );

    expect(configuredFields).toHaveLength(21);
    expect(new Set(configuredFields).size).toBe(21);
    expect([...configuredFields].sort()).toEqual([...PROFILE_FIELDS].sort());
  });

  it('offers the professional server filters without duplicating common supplier or DLC controls', () => {
    expect(charcuterieTraiteurPortal.fieldFilters.map((filter) => filter.field)).toEqual(PORTAL_FILTER_FIELDS);
    expect(charcuterieTraiteurPortal.fieldFilters.map((filter) => filter.field)).not.toContain('reseller_brand');
    expect(charcuterieTraiteurPortal.fieldFilters.map((filter) => filter.field)).not.toContain('expiry_date');

    expect(charcuterieTraiteurPortal.fieldFilters.find((filter) => filter.field === 'product_family')).toMatchObject({
      type: 'select',
      options: [
        { value: 'charcuterie', label: 'Charcuterie' },
        { value: 'traiteur', label: 'Traiteur' },
      ],
    });
    expect(charcuterieTraiteurPortal.fieldFilters.find((filter) => filter.field === 'storage_mode')).toMatchObject({
      type: 'select',
      options: [
        { value: 'chaîne froide', label: 'Chaîne froide' },
        { value: 'chaîne chaude', label: 'Chaîne chaude' },
      ],
    });
  });

  it('serializes all configured trade filters as repeated field_filter query parameters', () => {
    const filters: ArrivalFilters = {
      query: '',
      storeCode: '',
      status: '',
      supplier: 'Fournisseur commun',
      lotCode: '',
      gtin: '',
      dateFrom: '',
      dateTo: '',
      expiryFrom: '2026-08-01',
      expiryTo: '2026-08-31',
      sortBy: 'expiry_date',
      sortDirection: 'asc',
      fieldFilters: PORTAL_FILTER_FIELDS.map((field, index) => ({ field, value: `valeur ${index + 1}` })),
      view: 'table',
      page: 1,
    };

    const params = arrivalQueryParams('charcuterie_traiteur', filters, { limit: 50, offset: 0 });

    expect(params.get('profession')).toBe('charcuterie_traiteur');
    expect(params.get('supplier')).toBe('Fournisseur commun');
    expect(params.get('expiry_from')).toBe('2026-08-01');
    expect(params.get('expiry_to')).toBe('2026-08-31');
    expect(params.getAll('field_filter')).toEqual(
      PORTAL_FILTER_FIELDS.map((field, index) => `${field}:valeur ${index + 1}`),
    );
  });

  it('provides operational expiration columns', () => {
    expect(charcuterieTraiteurPortal.secondaryColumns.map((column) => column.source)).toEqual([
      'packaging_date',
      'use_by',
    ]);
  });

  it('keeps Charcuterie and Traiteur as families inside one combined portal', () => {
    expect(charcuterieTraiteurPortal.code).toBe('charcuterie_traiteur');
    expect(charcuterieTraiteurPortal.featureFlag).toBe('portal.charcuterie-traiteur');
    expect(charcuterieTraiteurPortal.label).toBe('Charcuterie–Traiteur');
    expect(charcuterieTraiteurPortal.shortLabel).toBe('Charcuterie–Traiteur');
    expect(charcuterieTraiteurPortal.labels.pageTitle).toContain('Charcuterie–Traiteur');
    expect(charcuterieTraiteurPortal.labels.emptyTitle).toContain('Charcuterie–Traiteur');
  });
});
