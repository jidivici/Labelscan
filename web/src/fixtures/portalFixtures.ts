import { CAPABILITIES, type Session, type Store } from '../types';

export const fixtureStores: Store[] = [
  { id: 'store-paris', code: 'PARIS-01', name: 'Paris Centre', active: true },
  { id: 'store-lyon', code: 'LYON-02', name: 'Lyon Part-Dieu', active: true },
];

export const managerFixtureSession: Session = {
  token: 'fixture-token',
  expiresAt: 4_102_444_800_000,
  user: {
    id: 'manager-1',
    username: 'manager.poissonnerie',
    display_name: 'Camille Martin',
    role: 'manager',
    store_code: 'PARIS-01',
    organization_id: 'organization-1',
    organization_slug: 'labelscan',
    capabilities: [CAPABILITIES.WEB_ACCESS, CAPABILITIES.ARRIVALS_READ, CAPABILITIES.OPERATORS_MANAGE],
    profession_codes: ['poissonnerie'],
    accessible_stores: [fixtureStores[0]],
    business_portal_ids: ['portal-poissonnerie-paris'],
  },
};

export const superAdminFixtureSession: Session = {
  token: 'fixture-token',
  expiresAt: 4_102_444_800_000,
  user: {
    id: 'super-admin-1',
    username: 'super.admin',
    display_name: 'Alex Dupont',
    role: 'super_admin',
    store_code: null,
    organization_id: 'organization-1',
    organization_slug: 'labelscan',
    capabilities: Object.values(CAPABILITIES),
    profession_codes: ['poissonnerie', 'boucherie', 'charcuterie_traiteur'],
    accessible_stores: fixtureStores,
    business_portal_ids: ['portal-poissonnerie-paris', 'portal-boucherie-paris', 'portal-charcuterie-paris'],
  },
};

export const adminFixtureSession: Session = {
  token: 'fixture-token',
  expiresAt: 4_102_444_800_000,
  user: {
    id: 'admin-1',
    username: 'dir',
    display_name: 'Direction',
    role: 'admin',
    store_code: null,
    organization_id: 'organization-1',
    organization_slug: 'labelscan',
    capabilities: [
      CAPABILITIES.WEB_ACCESS,
      CAPABILITIES.ARRIVALS_READ,
      CAPABILITIES.ADMIN_WORKSPACE_VIEW,
      CAPABILITIES.STORES_READ,
    ],
    profession_codes: [],
    accessible_stores: [],
    business_portal_ids: [],
  },
};
