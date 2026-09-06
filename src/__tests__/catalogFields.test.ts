import { apiRequest } from '../services/api';
import { businessProfileFor } from '../services/businessProfiles';
import { catalogQueryKey, listCatalogArticles } from '../services/catalogApi';
import { displayFinalFieldValue } from '../services/fieldLabels';

jest.mock('../services/api', () => ({ apiRequest: jest.fn() }));

const mockedApiRequest = apiRequest as jest.MockedFunction<typeof apiRequest>;

describe('catalogue field visibility', () => {
  it('normalizes every legacy spelling of NC only at the final UI boundary', () => {
    expect(displayFinalFieldValue('allergens', null)).toBe('NC');
    expect(displayFinalFieldValue('allergens', 'nc')).toBe('NC');
    expect(displayFinalFieldValue('allergens', ' Nc ')).toBe('NC');
  });

  it('shows allergens on one compact line and production methods in French', () => {
    expect(displayFinalFieldValue('allergens', 'Poisson\n\n• Crustacés\r\n- Mollusques'))
      .toBe('Poisson, Crustacés, Mollusques');
    expect(displayFinalFieldValue('production_method', 'wild_caught')).toBe('Pêche sauvage');
    expect(displayFinalFieldValue('production_method', 'farmed')).toBe('Élevage');
  });

  it('partitions catalogue cache entries by every authenticated scope dimension', () => {
    expect(catalogQueryKey({
      organizationId: 'org-1',
      actorId: 'actor-1',
      businessPortalId: 'portal-1',
      tradeCode: 'poissonnerie',
    })).toEqual([
      'catalog',
      'arrivals',
      'org-1',
      'actor-1',
      'portal-1',
      'poissonnerie',
    ]);
  });

  it('always exposes every field in the mandatory trade profile', async () => {
    mockedApiRequest.mockResolvedValue({
      items: [
        {
          batch_id: 'batch-1',
          store_code: 'STORE-1',
          product_name: 'Cabillaud',
          scientific_name: null,
          gtin: null,
          lot_code: 'LOT-1',
          supplier_name: null,
          status: 'registered',
          fao_area_code: null,
          production_method: null,
          use_by: null,
          packaging_date: null,
          recorded_at: '2026-08-31T10:00:00Z',
          photo_available: false,
          business_portal_id: 'portal-1',
          profession_code: 'poissonnerie',
          trade_profile_version: '2',
        },
      ],
      total: 1,
    });

    const [article] = await listCatalogArticles();
    const expected = businessProfileFor('poissonnerie').fields;

    expect(article.fields.map((field) => field.field_name)).toEqual(expected);
    expect(article.fields).toHaveLength(expected.length);
    expect(article.fields.find((field) => field.field_name === 'expiry_date')?.value).toBeNull();
    const absent = article.fields.filter((field) => field.value == null);
    expect(absent.length).toBeGreaterThan(0);
    expect(
      absent.every((field) => displayFinalFieldValue(field.field_name, field.value) === 'NC'),
    ).toBe(true);
  });
});
