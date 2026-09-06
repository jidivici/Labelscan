import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { AuthProvider } from '../../auth/AuthContext';
import { ApiProblem } from '../../api';
import { ApplicationRoutes } from '../../router/AppRouter';
import { CAPABILITIES, type Capability, type Role, type Session } from '../../types';
import {
  createAdmin,
  createManager,
  createStore,
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
  createStore: vi.fn(),
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
  vi.clearAllMocks();
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
  vi.mocked(createStore).mockResolvedValue(overview.stores[0]);
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
    const password = screen.getByLabelText('Mot de passe');
    expect(password).toHaveAttribute('autocomplete', 'off');
    if (_role === 'admin') {
      expect(password).not.toHaveAttribute('passwordrules');
      expect(password).not.toHaveAttribute('minlength');
    } else {
      expect(password).toHaveAttribute(
        'passwordrules',
        'minlength: 12; maxlength: 128; required: upper; required: lower; required: digit; required: special;',
      );
    }
    expect(password).toHaveAttribute('name', 'password');
    expect(password).toHaveAttribute('id', _role === 'admin' ? 'new-manager-password' : 'new-admin-password');
    expect(screen.getByLabelText('Identifiant')).toHaveAttribute('name', 'username');
  });

  it.each([
    ['une lettre accentuée', 'Abcdefghij1é'],
    ['un chiffre Unicode', 'Abcdefghij1٢'],
  ])('explains that %s is not the required special character', async (_case, password) => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/super-administration', superAdminSession);
    await screen.findByRole('heading', { name: 'Administrateurs' });

    await user.type(screen.getByLabelText('Mot de passe'), password);

    const submit = screen.getByRole('button', { name: 'Créer le compte' });
    expect(submit).toBeEnabled();
    expect(submit).toHaveClass('is-incomplete');
    await user.click(submit);
    expect(screen.getByLabelText('Identifiant')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Mot de passe')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Utilisez 12 à 128 caractères/)).toBeInTheDocument();
  });

  it('accepts punctuation as the required special character', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/super-administration', superAdminSession);
    await screen.findByRole('heading', { name: 'Administrateurs' });

    await user.type(screen.getByLabelText('Mot de passe'), 'Abcdefghi1é!');

    expect(screen.getByRole('button', { name: 'Créer le compte' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Créer le compte' })).toHaveClass('is-incomplete');
  });

  it('submits the password present in the DOM before the deferred AutoFill synchronization', async () => {
    renderAt('/o/labelscan/super-administration', superAdminSession);
    await screen.findByRole('heading', { name: 'Administrateurs' });
    const username = screen.getByLabelText('Identifiant');
    const password = screen.getByLabelText('Mot de passe');
    const form = password.closest('form')!;

    fireEvent.change(username, { target: { value: 'admin.autofill' } });
    fireEvent.input(password, { target: { value: 'Strong-Safari-42!' } });
    fireEvent.submit(form);

    await waitFor(() => expect(createAdmin).toHaveBeenCalledWith(superAdminSession, {
      username: 'admin.autofill',
      password: 'Strong-Safari-42!',
    }));
  });

  it('reveals a password filled by Safari', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/administration', adminSession);
    await screen.findByRole('heading', { name: 'Équipe et magasins' });
    const password = screen.getByLabelText('Mot de passe') as HTMLInputElement;

    // Safari can populate the DOM value without firing an input event.
    password.value = 'Safari-AutoFill-42!';
    await user.click(screen.getByRole('button', { name: 'Afficher le mot de passe' }));

    expect(password).toHaveAttribute('type', 'text');
    expect(password).toHaveValue('Safari-AutoFill-42!');
    expect(screen.getByRole('button', { name: 'Masquer le mot de passe' })).toBeInTheDocument();
  });

  it('shows complete inline guidance instead of native manager-form bubbles', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/administration', adminSession);
    await screen.findByRole('heading', { name: 'Équipe et magasins' });
    const form = document.querySelector<HTMLFormElement>('#create-manager-form')!;

    expect(form).toHaveAttribute('novalidate');
    const submit = within(form).getByRole('button', { name: 'Créer le compte' });
    expect(submit).toHaveClass('is-incomplete');
    await user.click(submit);

    expect(within(form).getByText('Renseignez un identifiant.')).toBeInTheDocument();
    expect(within(form).getByText('Renseignez un mot de passe.')).toBeInTheDocument();
    expect(within(form).getByText('Choisissez un magasin et un métier actifs.')).toBeInTheDocument();
    expect(within(form).getByLabelText('Identifiant')).toHaveFocus();
    expect(createManager).not.toHaveBeenCalled();
  });

  it('submits manager credentials read directly from Safari AutoFill', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/administration', adminSession);
    await screen.findByRole('heading', { name: 'Équipe et magasins' });
    const form = document.querySelector<HTMLFormElement>('#create-manager-form')!;
    await user.click(within(form).getByRole('button', { name: 'Magasin et métier attribués' }));
    await user.click(screen.getByRole('option', { name: 'Paris Centre · Poissonnerie' }));
    const username = within(form).getByLabelText('Identifiant') as HTMLInputElement;
    const password = within(form).getByLabelText('Mot de passe') as HTMLInputElement;

    username.value = 'manager.safari';
    password.value = 'safari-secret';
    const submit = within(form).getByRole('button', { name: 'Créer le compte' });
    await waitFor(() => expect(submit).toHaveClass('is-complete'));
    await user.click(submit);

    await waitFor(() => expect(createManager).toHaveBeenCalledWith(adminSession, {
      username: 'manager.safari',
      password: 'safari-secret',
      business_portal_ids: ['portal-fish-paris'],
    }));
  });

  it('shows both missing fields for the new-store form', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/administration', adminSession);
    const panel = (await screen.findByRole('heading', { name: 'Nouveau magasin' })).closest('section')!;
    const form = panel.querySelector('form')!;

    const submit = within(form).getByRole('button', { name: 'Ajouter le magasin' });
    expect(submit).toHaveClass('is-incomplete');
    await user.click(submit);

    expect(within(form).getByText('Renseignez le nom du magasin.')).toBeInTheDocument();
    expect(within(form).getByText('Choisissez au moins un métier.')).toBeInTheDocument();
    expect(within(form).getByLabelText('Nom du magasin')).toHaveFocus();
    expect(createStore).not.toHaveBeenCalled();
  });

  it('clears validation errors from the other creation form', async () => {
    const user = userEvent.setup();
    renderAt('/o/labelscan/administration', adminSession);
    const storePanel = (await screen.findByRole('heading', { name: 'Nouveau magasin' })).closest('section')!;
    const managerForm = document.querySelector<HTMLFormElement>('#create-manager-form')!;

    await user.click(within(storePanel).getByRole('button', { name: 'Ajouter le magasin' }));
    expect(within(storePanel).getByText('Choisissez au moins un métier.')).toBeInTheDocument();

    await user.click(within(managerForm).getByRole('button', { name: 'Créer le compte' }));

    expect(within(storePanel).queryByText('Renseignez le nom du magasin.')).not.toBeInTheDocument();
    expect(within(storePanel).queryByText('Choisissez au moins un métier.')).not.toBeInTheDocument();
    expect(within(managerForm).getByText('Renseignez un identifiant.')).toBeInTheDocument();
  });

  it('shows a same-store identifier conflict on the username field', async () => {
    const user = userEvent.setup();
    vi.mocked(createManager).mockRejectedValueOnce(
      new ApiProblem('USER_ALREADY_EXISTS', 'cet identifiant est déjà utilisé dans ce magasin'),
    );
    renderAt('/o/labelscan/administration', adminSession);
    await screen.findByRole('heading', { name: 'Équipe et magasins' });
    const form = document.querySelector<HTMLFormElement>('#create-manager-form')!;

    await user.type(within(form).getByLabelText('Identifiant'), 'manager.existant');
    await user.type(within(form).getByLabelText('Mot de passe'), 'mot-de-passe');
    await user.click(within(form).getByRole('button', { name: 'Magasin et métier attribués' }));
    await user.click(screen.getByRole('option', { name: 'Paris Centre · Poissonnerie' }));
    await user.click(within(form).getByRole('button', { name: 'Créer le compte' }));

    expect(await within(form).findByText('Cet identifiant est déjà utilisé dans ce magasin.')).toBeInTheDocument();
    expect(within(form).getByLabelText('Identifiant')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a same-store password conflict on the password field', async () => {
    const user = userEvent.setup();
    vi.mocked(createManager).mockRejectedValueOnce(
      new ApiProblem('PASSWORD_ALREADY_EXISTS', 'ce mot de passe est déjà utilisé dans ce magasin'),
    );
    renderAt('/o/labelscan/administration', adminSession);
    await screen.findByRole('heading', { name: 'Équipe et magasins' });
    const form = document.querySelector<HTMLFormElement>('#create-manager-form')!;

    await user.type(within(form).getByLabelText('Identifiant'), 'manager.nouveau');
    await user.type(within(form).getByLabelText('Mot de passe'), 'mot-de-passe-partage');
    await user.click(within(form).getByRole('button', { name: 'Magasin et métier attribués' }));
    await user.click(screen.getByRole('option', { name: 'Paris Centre · Poissonnerie' }));
    await user.click(within(form).getByRole('button', { name: 'Créer le compte' }));

    expect(await within(form).findByText('Ce mot de passe est déjà utilisé dans ce magasin.')).toBeInTheDocument();
    expect(within(form).getByLabelText('Mot de passe')).toHaveAttribute('aria-invalid', 'true');
  });

  it('marks both fields when the complete credential pair exists elsewhere', async () => {
    const user = userEvent.setup();
    vi.mocked(createManager).mockRejectedValueOnce(
      new ApiProblem(
        'CREDENTIAL_PAIR_ALREADY_EXISTS',
        'ce couple identifiant et mot de passe est déjà utilisé dans un autre magasin',
      ),
    );
    renderAt('/o/labelscan/administration', adminSession);
    await screen.findByRole('heading', { name: 'Équipe et magasins' });
    const form = document.querySelector<HTMLFormElement>('#create-manager-form')!;

    await user.type(within(form).getByLabelText('Identifiant'), 'manager.partage');
    await user.type(within(form).getByLabelText('Mot de passe'), 'mot-de-passe-partage');
    await user.click(within(form).getByRole('button', { name: 'Magasin et métier attribués' }));
    await user.click(screen.getByRole('option', { name: 'Paris Centre · Poissonnerie' }));
    await user.click(within(form).getByRole('button', { name: 'Créer le compte' }));

    expect(within(form).getByLabelText('Identifiant')).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByLabelText('Mot de passe')).toHaveAttribute('aria-invalid', 'true');
  });

});

describe('IAM bounded actions', () => {
  it('filters team results when the global store and profession scopes change', async () => {
    const user = userEvent.setup();
    const parisFishManager = iamUser({
      id: 'manager-paris-fish',
      username: 'manager.paris.poissonnerie',
      role: 'manager',
      business_portal_ids: ['portal-fish-paris'],
    });
    const parisMeatManager = iamUser({
      id: 'manager-paris-meat',
      username: 'manager.paris.boucherie',
      role: 'manager',
      business_portal_ids: ['portal-meat-paris'],
    });
    vi.mocked(listManagers).mockResolvedValueOnce([manager, parisFishManager, parisMeatManager]);

    renderAt('/o/labelscan/administration', adminSession);
    await screen.findByText('manager.lyon');

    await user.click(screen.getByRole('button', { name: 'Magasin Tous les magasins' }));
    await user.click(screen.getByRole('option', { name: 'Paris Centre' }));
    await waitFor(() => expect(screen.queryByText('manager.lyon')).not.toBeInTheDocument());
    expect(screen.getByText('manager.paris.poissonnerie')).toBeInTheDocument();
    expect(screen.getByText('manager.paris.boucherie')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Métier Tous les métiers' }));
    await user.click(screen.getByRole('option', { name: 'Boucherie' }));
    await waitFor(() => expect(screen.queryByText('manager.paris.poissonnerie')).not.toBeInTheDocument());
    expect(screen.getByText('manager.paris.boucherie')).toBeInTheDocument();
  });

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
