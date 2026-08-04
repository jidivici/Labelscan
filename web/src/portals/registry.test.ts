import { describe, expect, it } from 'vitest';

import { PROFESSION_CODES } from '../types';
import { PORTALS, portalDefinition } from './registry';

describe('portal registry contract', () => {
  it('publishes exactly one complete configuration per supported profession', () => {
    expect(Object.keys(PORTALS)).toEqual(PROFESSION_CODES);
    for (const code of PROFESSION_CODES) {
      const portal = PORTALS[code];
      expect(portal.detailSections.length).toBeGreaterThanOrEqual(3);
      expect(portal.fieldFilters.length).toBeGreaterThan(0);
      expect(portal.secondaryColumns.length).toBeGreaterThan(0);
      expect(portal.kpis.map((kpi) => kpi.metric)).toEqual(['total', 'flagged', 'openAlerts', 'incomplete']);
      expect(portal.labels.emptyTitle).not.toBe('');
    }
  });

  it('keeps métier filter names aligned with profile field names', () => {
    expect(PORTALS.poissonnerie.fieldFilters.map((filter) => filter.field)).toEqual([
      'commercial_designation',
      'scientific_name',
      'FAO_area',
      'production_method',
      'fishing_gear_or_farming_method',
    ]);
    expect(PORTALS.boucherie.fieldFilters.map((filter) => filter.field)).toEqual([
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
    ]);
    expect(PORTALS.charcuterie_traiteur.fieldFilters.map((filter) => filter.field)).toEqual([
      'product_family',
      'manufacturer_name',
      'allergens',
      'conditioning_type',
      'preparation_date',
      'storage_temperature',
      'storage_mode',
      'ingredients',
      'additives',
    ]);
  });

  it('fails closed for an unknown profession', () => {
    expect(portalDefinition('inconnu')).toBeNull();
  });
});
