import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { AuthProvider } from '../../auth/AuthContext';
import { ApplicationRoutes } from '../../router/AppRouter';
import { CAPABILITIES, type Capability, type Role, type Session } from '../../types';
import {
  createAdmin,
  createManager,
  deactivateAdmin,
  deleteManager,
  getIamOverview,
  listAdmins,
  listManagers,
  listStorePortals,
  replaceManagerPortals,
  setStorePortalActive,
} from './client';
import type { IamOverview, IamPortal, IamUser } from './types';

vi.mock('./client', () => ({
  createAdmin: vi.fn(),
  createManager: vi.fn(),
  deactivateAdmin: vi.fn(),
  deleteManager: vi.fn(),
  getIamOverview: vi.fn(),
  listAdmins: vi.fn(),
  listManagers: vi.fn(),
  listStorePortals: vi.fn(),
  replaceManagerPortals: vi.fn(),
  setStorePortalActive: vi.fn(),
}));

const portals: IamPortal[] = [
  {
    id: 'portal-fish-paris',
    store_id: 'store-paris',
    store_code: 'PARIS-01',
    store_name: 'Paris Centre',
    profession_code: 'poissonnerie',
    profession_name: 'Poissonnerie',
    name: 'Poissonnerie',
    active: true,
  },
  {
    id: 'portal-fish-lyon',
    store_id: 'store-lyon',
    store_code: 'LYON-02',
    store_name: 'Lyon Part-Dieu',
    profession_code: 'poissonnerie',
    profession_name: 'Poissonnerie',
    name: 'Poissonnerie',
    active: true,
  },
  {
    id: 'portal-meat-paris',
    store_id: 'store-paris',
    store_code: 'PARIS-01',
    store_name: 'Paris Centre',
    profession_code: 'boucherie',
    profession_name: 'Boucherie',
    name: 'Boucherie',
    active: true,
  },
];

function iamUser(overrides: Partial<IamUser> = {}): IamUser {
  return {
    id: 'operator-1',
    username: 'operator.paris',
    display_name: 'Lina Bernard',
    role: 'operator',
    active: true,
    organization_id: 'organization-1',
    store_id: 'store-paris',
    store_code: 'PARIS-01',
    business_portal_ids: ['portal-fish-paris'],
    created_by: 'manager-1',
    created_at: '2026-08-04T10:00:00Z',
    updated_at: '2026-08-04T10:00:00Z',
    ...overrides,
  };
}

const overview: IamOverview = {
  user: iamUser({ id: 'manager-1', role: 'manager', username: 'manager', display_name: 'Manager' }),
  capabilities: [],
  scopes: [],
  stores: [
    { id: 'store-paris', code: 'PARIS-01', name: 'Paris Centre', active: true },
    { id: 'store-lyon', code: 'LYON-02', name: 'Lyon Part-Dieu', active: true },
  ],
  business_portals: portals,
};

const manager = iamUser({
  id: 'manager-2',
  username: 'manager.lyon',
  display_name: 'Nora Petit',
  role: 'manager',
  store_id: null,
  store_code: null,
  business_portal_ids: ['portal-fish-lyon'],
});
const admin = iamUser({
  id: 'admin-1',
  username: 'admin.paris',
  display_name: 'Alex Martin',
  role: 'admin',
  store_id: null,
  store_code: null,
  business_portal_ids: [],
});

function session(role: Role, capabilities: Capability[]): Session {
  const portalIds = role === 'manager' ? ['portal-fish-paris', 'portal-fish-lyon'] : portals.map((portal) => portal.id);
  return {
    token: `${role}-token`,
    expiresAt: 4_102_444_800_000,
    user: {
      id: `${role}-1`,
      username: role,
      display_name: role,
      role,
      store_code: role === 'manager' ? 'PARIS-01' : null,
      organization_id: 'organization-1',
      organization_slug: 'labelscan',
      capabilities,
      profession_codes: ['poissonnerie', 'boucherie'],
      accessible_stores: overview.stores,
      business_portal_ids: portalIds,
    },
  };
}

const managerSession = session('manager', [
  CAPABILITIES.WEB_ACCESS,
  CAPABILITIES.ARRIVALS_READ,
  CAPABILITIES.OPERATORS_MANAGE,
]);
const adminSession = session('admin', [
  CAPABILITIES.WEB_ACCESS,
  CAPABILITIES.ADMIN_WORKSPACE_VIEW,
  CAPABILITIES.STORES_READ,
  CAPABILITIES.STORES_MANAGE,
  CAPABILITIES.MANAGER_ASSIGNMENTS_MANAGE,
]);
const superAdminSession = session('super_admin', [
  CAPABILITIES.WEB_ACCESS,
  CAPABILITIES.ARRIVALS_READ,
  CAPABILITIES.OPERATORS_MANAGE,
  CAPABILITIES.ADMIN_WORKSPACE_VIEW,
  CAPABILITIES.STORES_READ,
  CAPABILITIES.STORES_MANAGE,
  CAPABILITIES.MANAGER_ASSIGNMENTS_MANAGE,
  CAPABILITIES.SUPER_ADMIN_WORKSPACE_VIEW,
  CAPABILITIES.ADMINS_MANAGE,
]);

function renderAt(path: string, currentSession: Session) {
  const { hook } = memoryLocation({ path });
  return render(
    <Router hook={hook}>
      <AuthProvider initialSession={currentSession}>
        <ApplicationRoutes />
      </AuthProvider>
    </Router>,
  );
}

beforeEach(() => {
  vi.mocked(getIamOverview).mockResolvedValue(overview);
  vi.mocked(listManagers).mockResolvedValue([manager]);
  vi.mocked(listAdmins).mockResolvedValue([admin]);
  vi.mocked(listStorePortals).mockResolvedValue(portals.filter((portal) => portal.store_id === 'store-paris'));
  vi.mocked(deleteManager).mockResolvedValue(undefined);
  vi.mocked(replaceManagerPortals).mockResolvedValue(manager);
  vi.mocked(setStorePortalActive).mockImplementation(async (_session, _storeId, portalId, active) => ({
    ...portals.find((portal) => portal.id === portalId)!,
    active,
  }));
  vi.mocked(deactivateAdmin).mockResolvedValue(undefined);
  vi.mocked(createManager).mockResolvedValue(manager);
  vi.mocked(createAdmin).mockResolvedValue(admin);
});

describe('IAM workspace capability visibility', () => {
  it.each([
    ['admin', adminSession, '/o/labelscan/administration', 'Équipe et magasins'],
    ['super_admin', superAdminSession, '/o/labelscan/super-administration', 'Administrateurs'],
  ])('shows the capability-appropriate surface for %s', async (_role, currentSession, path, heading) => {
    renderAt(path, currentSession);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  });

  it.each([
    ['manager', managerSession, '/o/labelscan/administration'],
    ['manager', managerSession, '/o/labelscan/super-administration'],
    ['admin', adminSession, '/o/labelscan/super-administration'],
    ['super_admin sans admins:manage', session('super_admin', [CAPABILITIES.WEB_ACCESS, CAPABILITIES.SUPER_ADMIN_WORKSPACE_VIEW]), '/o/labelscan/super-administration'],
  ])('denies %s when the required capability is absent', async (_role, currentSession, path) => {
    renderAt(path, currentSession);
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
  });
});

describe('IAM credentials', () => {
  it.each([
    ['admin', adminSession, '/o/labelscan/administration', 'Équipe et magasins'],
    ['super_admin', superAdminSession, '/o/labelscan/super-administration', 'Administrateurs'],
  ])('creates %s accounts with a direct password', async (_role, currentSession, path, heading) => {
    renderAt(path, currentSession);
    await screen.findByRole('heading', { name: heading });
    expect(screen.getByLabelText('Mot de passe')).toBeInTheDocument();
  });

});

describe('IAM bounded actions', () => {
  it('saves a manager assignment immediately without an Enregistrer action', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/administration', adminSession);
    const section = (await screen.findByRole('heading', { name: 'Managers' })).closest('section')!;
    expect(within(section).queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: 'Magasin et métier de manager.lyon' }));
    await user.click(screen.getByRole('option', { name: 'Paris Centre · Poissonnerie' }));

    await waitFor(() => expect(replaceManagerPortals).toHaveBeenCalledWith(
      adminSession,
      manager.id,
      ['portal-fish-paris'],
    ));
  });

  it('removes a manager from the front through the soft-delete endpoint', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/administration', adminSession);
    const section = (await screen.findByRole('heading', { name: 'Managers' })).closest('section')!;
    await user.click(within(section).getByRole('button', { name: 'Supprimer' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Supprimer ce manager ?' });
    expect(within(dialog).getByText(/historique restera associé/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Supprimer' }));

    await waitFor(() => expect(deleteManager).toHaveBeenCalledWith(adminSession, manager.id));
  });

  it('keeps a refused deletion inside the confirmation dialog without a global technical alert', async () => {
    const user = userEvent.setup();
    vi.mocked(deleteManager).mockRejectedValueOnce(new Error('technical backend detail'));
    renderAt('/o/labelscan/administration', adminSession);
    const section = (await screen.findByRole('heading', { name: 'Managers' })).closest('section')!;
    await user.click(within(section).getByRole('button', { name: 'Supprimer' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Supprimer ce manager ?' });
    await user.click(within(dialog).getByRole('button', { name: 'Supprimer' }));

    expect(await within(dialog).findByText(/ne peut pas être supprimé pour le moment/)).toBeInTheDocument();
    expect(screen.queryByText('technical backend detail')).not.toBeInTheDocument();
  });

  it('presents the absence of a store as an onboarding state instead of an error', async () => {
    vi.mocked(getIamOverview).mockResolvedValueOnce({ ...overview, stores: [], business_portals: [] });
    renderAt('/o/labelscan/administration', adminSession);

    expect(await screen.findByRole('heading', { name: 'Créez d’abord un magasin' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Identifiant')).not.toBeInTheDocument();
  });

  it('shows discreet ten-item pages for managers and stores', async () => {
    const user = userEvent.setup();
    const manyManagers = Array.from({ length: 11 }, (_, index) => iamUser({
      id: `manager-${index + 1}`,
      username: `manager.${index + 1}`,
      display_name: `Manager ${index + 1}`,
      role: 'manager',
      business_portal_ids: ['portal-fish-paris'],
    }));
    const manyStores = Array.from({ length: 11 }, (_, index) => ({
      id: `store-${index + 1}`,
      code: `STORE-${index + 1}`,
      name: `Magasin ${index + 1}`,
      active: true,
    }));
    vi.mocked(listManagers).mockResolvedValueOnce(manyManagers);
    vi.mocked(getIamOverview).mockResolvedValueOnce({ ...overview, stores: manyStores });

    renderAt('/o/labelscan/administration', adminSession);
    const managersSection = (await screen.findByRole('heading', { name: 'Managers' })).closest('section')!;
    expect(within(managersSection).getByRole('navigation', { name: 'Pagination des managers' })).toBeInTheDocument();
    expect(within(managersSection).getByText('manager.10')).toBeInTheDocument();
    expect(within(managersSection).queryByText('manager.11')).not.toBeInTheDocument();
    await user.click(within(managersSection).getByRole('button', { name: 'des managers suivants' }));
    expect(within(managersSection).getByText('manager.11')).toBeInTheDocument();

    const storesSection = screen.getByRole('heading', { name: 'Magasins' }).closest('section')!;
    expect(within(storesSection).getByRole('navigation', { name: 'Pagination des magasins' })).toBeInTheDocument();
    expect(within(storesSection).getByText('Magasin 10')).toBeInTheDocument();
    expect(within(storesSection).queryByText('Magasin 11')).not.toBeInTheDocument();
    await user.click(within(storesSection).getByRole('button', { name: 'des magasins suivants' }));
    expect(within(storesSection).getByText('Magasin 11')).toBeInTheDocument();
  });

  it('paginates administrator accounts ten at a time', async () => {
    const user = userEvent.setup();
    const manyAdmins = Array.from({ length: 11 }, (_, index) => iamUser({
      id: `admin-${index + 1}`,
      username: `admin.${index + 1}`,
      display_name: `Admin ${index + 1}`,
      role: 'admin',
      business_portal_ids: [],
    }));
    vi.mocked(listAdmins).mockResolvedValueOnce(manyAdmins);

    renderAt('/o/labelscan/super-administration', superAdminSession);
    const section = (await screen.findByRole('heading', { name: 'Comptes administrateurs' })).closest('section')!;
    expect(within(section).getByRole('navigation', { name: 'Pagination des administrateurs' })).toBeInTheDocument();
    expect(within(section).getByText('admin.10')).toBeInTheDocument();
    expect(within(section).queryByText('admin.11')).not.toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'des administrateurs suivants' }));
    expect(within(section).getByText('admin.11')).toBeInTheDocument();
  });

  it('uses the idempotent store-portal state endpoint from the admin surface', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/administration', adminSession);
    const section = (await screen.findByRole('heading', { name: 'Métiers par magasin' })).closest('section')!;
    const storeTrigger = within(section).getByRole('button', { name: 'Magasin' });
    expect(within(section).queryByRole('combobox')).not.toBeInTheDocument();
    await user.click(storeTrigger);
    expect(screen.getByRole('listbox', { name: 'Magasin' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await user.click(screen.getByRole('option', { name: 'Lyon Part-Dieu' }));
    expect(storeTrigger).toHaveTextContent('Lyon Part-Dieu');
    await user.click((await within(section).findAllByRole('button', { name: 'Désactiver' }))[0]);
    await waitFor(() => expect(setStorePortalActive).toHaveBeenCalledWith(
      adminSession,
      'store-lyon',
      'portal-fish-paris',
      false,
    ));
  });
});
