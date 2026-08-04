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
  createOperator,
  deactivateAdmin,
  getIamOverview,
  listAdmins,
  listManagers,
  listOperators,
  listStorePortals,
  replaceManagerPortals,
  resetOperatorCredential,
  setManagerActive,
  setStorePortalActive,
  updateOperator,
} from './client';
import type { ActivationGrant, IamOverview, IamPortal, IamUser } from './types';

vi.mock('./client', () => ({
  createAdmin: vi.fn(),
  createManager: vi.fn(),
  createOperator: vi.fn(),
  deactivateAdmin: vi.fn(),
  getIamOverview: vi.fn(),
  listAdmins: vi.fn(),
  listManagers: vi.fn(),
  listOperators: vi.fn(),
  listStorePortals: vi.fn(),
  replaceManagerPortals: vi.fn(),
  resetOperatorCredential: vi.fn(),
  setManagerActive: vi.fn(),
  setStorePortalActive: vi.fn(),
  updateOperator: vi.fn(),
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

const operator = iamUser();
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

const operatorSession = session('operator', [CAPABILITIES.ARRIVALS_READ]);
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
  vi.mocked(listOperators).mockResolvedValue([operator]);
  vi.mocked(listManagers).mockResolvedValue([manager]);
  vi.mocked(listAdmins).mockResolvedValue([admin]);
  vi.mocked(listStorePortals).mockResolvedValue(portals.filter((portal) => portal.store_id === 'store-paris'));
  vi.mocked(updateOperator).mockResolvedValue(operator);
  vi.mocked(setManagerActive).mockResolvedValue(manager);
  vi.mocked(replaceManagerPortals).mockResolvedValue(manager);
  vi.mocked(setStorePortalActive).mockImplementation(async (_session, _storeId, portalId, active) => ({
    ...portals.find((portal) => portal.id === portalId)!,
    active,
  }));
  vi.mocked(deactivateAdmin).mockResolvedValue(undefined);
  vi.mocked(createOperator).mockResolvedValue({} as ActivationGrant);
  vi.mocked(createManager).mockResolvedValue({} as ActivationGrant);
  vi.mocked(createAdmin).mockResolvedValue({} as ActivationGrant);
  vi.mocked(resetOperatorCredential).mockResolvedValue({
    user: operator,
    activation_token: 'operator-reset-secret',
    expires_at: '2026-08-05T10:00:00Z',
  });
});

describe('IAM workspace capability visibility', () => {
  it.each([
    ['operator', operatorSession, '/o/labelscan/portails/poissonnerie/operateurs', 'Accès non autorisé'],
    ['manager', managerSession, '/o/labelscan/portails/poissonnerie/operateurs', 'Opérateurs'],
    ['admin', adminSession, '/o/labelscan/administration', 'Magasins et managers'],
    ['super_admin', superAdminSession, '/o/labelscan/super-administration', 'Administrateurs'],
  ])('shows the capability-appropriate surface for %s', async (_role, currentSession, path, heading) => {
    renderAt(path, currentSession);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  });

  it.each([
    ['manager', managerSession, '/o/labelscan/administration'],
    ['manager', managerSession, '/o/labelscan/super-administration'],
    ['admin', adminSession, '/o/labelscan/super-administration'],
    ['admin', adminSession, '/o/labelscan/portails/poissonnerie/operateurs'],
    ['super_admin sans admins:manage', session('super_admin', [CAPABILITIES.WEB_ACCESS, CAPABILITIES.SUPER_ADMIN_WORKSPACE_VIEW]), '/o/labelscan/super-administration'],
  ])('denies %s when the required capability is absent', async (_role, currentSession, path) => {
    renderAt(path, currentSession);
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
  });
});

describe('IAM credential boundaries', () => {
  it.each([
    ['admin', adminSession, '/o/labelscan/administration'],
    ['super_admin', superAdminSession, '/o/labelscan/super-administration'],
  ])('never renders a credential form for %s', async (_role, currentSession, path) => {
    const view = renderAt(path, currentSession);
    await screen.findByRole('heading', { name: _role === 'admin' ? 'Magasins et managers' : 'Administrateurs' });
    expect(view.container.querySelector('input[type="password"]')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /réinitialiser.*administrateur|réinitialiser.*manager/i })).not.toBeInTheDocument();
  });

  it('reveals an operator reset token only after the manager requests it', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/portails/poissonnerie/operateurs', managerSession);
    expect(screen.queryByText('operator-reset-secret')).not.toBeInTheDocument();
    const resetButton = await screen.findByRole('button', { name: 'Réinitialiser l’accès de Lina Bernard' });
    await user.click(resetButton);
    expect(await screen.findByText('operator-reset-secret')).toBeInTheDocument();
    expect(resetOperatorCredential).toHaveBeenCalledWith(managerSession, operator.id);
  });
});

describe('IAM bounded actions', () => {
  it('creates an operator without sending a password field', async () => {
    const user = userEvent.setup();
    vi.mocked(createOperator).mockResolvedValue({
      user: operator,
      activation_token: 'initial-operator-code',
      expires_at: '2026-08-05T10:00:00Z',
    });
    renderAt('/o/labelscan/portails/poissonnerie/operateurs', managerSession);
    const form = await screen.findByRole('button', { name: 'Créer et générer le code' });
    const panel = form.closest('section')!;
    await user.type(within(panel).getByRole('textbox', { name: 'Identifiant' }), 'new.operator');
    await user.type(within(panel).getByRole('textbox', { name: 'Nom affiché' }), 'Nouvel opérateur');
    await user.click(form);
    await waitFor(() => expect(createOperator).toHaveBeenCalledWith(
      managerSession,
      'portal-fish-paris',
      { username: 'new.operator', display_name: 'Nouvel opérateur' },
    ));
    expect(vi.mocked(createOperator).mock.calls[0][2]).not.toHaveProperty('password');
  });

  it('uses the idempotent store-portal activation endpoint from the admin surface', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/administration', adminSession);
    const portalHeading = await screen.findByRole('heading', { name: 'Poissonnerie' });
    const card = portalHeading.closest('article')!;
    await user.click(within(card).getByRole('button', { name: 'Désactiver' }));
    await waitFor(() => expect(setStorePortalActive).toHaveBeenCalledWith(
      adminSession,
      'store-paris',
      'portal-fish-paris',
      false,
    ));
  });
});
