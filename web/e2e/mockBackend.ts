import type { Page, Route } from '@playwright/test';

export type TestRole = 'operator' | 'manager' | 'admin' | 'super_admin';

interface MockOptions {
  role: TestRole;
  denyLogin?: boolean;
  restoreSession?: boolean;
  meGate?: Promise<void>;
}

export interface MockBackend {
  requests: string[];
}

const stores = [
  { id: 'store-paris', code: 'PARIS-01', name: 'Marché République', active: true },
  { id: 'store-lyon', code: 'LYON-02', name: 'Halles de Lyon', active: true },
  { id: 'store-lille', code: 'LILLE-03', name: 'Marché de Lille', active: true },
];

const portals = [
  {
    id: 'portal-poissonnerie-paris',
    store_id: 'store-paris',
    store_code: 'PARIS-01',
    store_name: 'Marché République',
    profession_code: 'poissonnerie',
    profession_name: 'Poissonnerie',
    name: 'Poissonnerie · République',
    active: true,
  },
  {
    id: 'portal-boucherie-lyon',
    store_id: 'store-lyon',
    store_code: 'LYON-02',
    store_name: 'Halles de Lyon',
    profession_code: 'boucherie',
    profession_name: 'Boucherie',
    name: 'Boucherie · Lyon',
    active: true,
  },
  {
    id: 'portal-charcuterie-lille',
    store_id: 'store-lille',
    store_code: 'LILLE-03',
    store_name: 'Marché de Lille',
    profession_code: 'charcuterie_traiteur',
    profession_name: 'Charcuterie–Traiteur',
    name: 'Charcuterie–Traiteur · Lille',
    active: true,
  },
];

const managers = [
  iamUser('manager-fish', 'manager.poisson', 'Marion Poisson', 'manager', ['portal-poissonnerie-paris']),
  iamUser('manager-meat', 'manager.viande', 'Bastien Viande', 'manager', ['portal-boucherie-lyon']),
  iamUser('manager-catering', 'manager.traiteur', 'Charlie Traiteur', 'manager', ['portal-charcuterie-lille']),
];

const operators = [
  iamUser('operator-fish', 'operateur.maree', 'Océane Martin', 'operator', ['portal-poissonnerie-paris']),
];

const admins = [
  iamUser('admin-north', 'admin.nord', 'Alice Nord', 'admin', []),
  iamUser('admin-south', 'admin.sud', 'Amine Sud', 'admin', []),
];

function iamUser(id: string, username: string, displayName: string, role: TestRole, businessPortalIds: string[]) {
  return {
    id,
    username,
    display_name: displayName,
    role,
    active: true,
    organization_id: 'organization-labelscan',
    store_id: null,
    store_code: null,
    business_portal_ids: businessPortalIds,
    created_by: 'system',
    created_at: '2026-08-01T08:00:00Z',
    updated_at: '2026-08-01T08:00:00Z',
  };
}

function roleAccess(role: TestRole) {
  if (role === 'manager') {
    return {
      scopes: ['catalog:read', 'identity:operators:manage'],
      stores: [stores[0], stores[2]],
      portals: [portals[0], portals[2]],
    };
  }
  if (role === 'admin') {
    return {
      scopes: ['catalog:read', 'identity:read', 'identity:portals:manage', 'identity:managers:manage'],
      stores,
      portals,
    };
  }
  if (role === 'super_admin') {
    return {
      scopes: ['catalog:read', 'identity:read', 'identity:admins:manage'],
      stores,
      portals,
    };
  }
  return { scopes: [], stores: [], portals: [] };
}

function displayName(role: TestRole): string {
  return {
    operator: 'Olivia Opératrice',
    manager: 'Marc Manager',
    admin: 'Adèle Admin',
    super_admin: 'Sonia Super Admin',
  }[role];
}

function authPayload(role: TestRole) {
  return {
    access_token: `token-${role}`,
    expires_in: 3600,
    user: {
      id: `user-${role}`,
      username: `${role}@labelscan.test`,
      display_name: displayName(role),
      role,
      store_code: null,
      organization_id: 'organization-labelscan',
      organization_slug: 'labelscan',
    },
  };
}

function overview(role: TestRole) {
  const access = roleAccess(role);
  return {
    user: {
      ...iamUser(`user-${role}`, `${role}@labelscan.test`, displayName(role), role, access.portals.map(({ id }) => id)),
    },
    capabilities: [],
    scopes: access.scopes,
    stores: access.stores,
    business_portals: access.portals,
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function arrivalPage(url: URL) {
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  let total = 101;
  if (url.searchParams.get('status') === 'flagged') total = 9;
  if (url.searchParams.get('alert_state') === 'open') total = 4;
  if (url.searchParams.get('completeness_min') === '100') total = 80;
  const items = limit === 50 ? [{
    batch_id: `batch-${offset}`,
    store_code: 'PARIS-01',
    profession_code: url.searchParams.get('profession'),
    product_name: offset ? 'Saumon page 2' : 'Saumon atlantique',
    scientific_name: 'Salmo salar',
    gtin: '03012345678903',
    lot_code: `LOT-${offset || 1}`,
    supplier_name: 'Criée Atlantique',
    status: 'registered',
    fao_area_code: '27',
    production_method: 'farmed',
    use_by: '2026-08-08',
    packaging_date: '2026-08-03',
    recorded_at: '2026-08-04T08:00:00Z',
    photo_available: false,
    completeness: 94,
    alert_state: 'open',
    alert_severity: 'warning',
  }] : [];
  return { items, total, limit, offset };
}

export async function installMockBackend(page: Page, options: MockOptions): Promise<MockBackend> {
  const requests: string[] = [];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}${url.search}`;
    requests.push(key);

    if (url.pathname === '/v1/auth/refresh') {
      if (options.restoreSession) await json(route, authPayload(options.role));
      else await route.fulfill({ status: 204 });
      return;
    }
    if (url.pathname === '/v1/auth/logout') {
      await route.fulfill({ status: 204 });
      return;
    }
    if (/^\/v1\/o\/[^/]+\/auth\/login$/.test(url.pathname)) {
      if (options.denyLogin) {
        await json(route, { error_code: 'WEB_ACCESS_DENIED', detail: 'Ce compte opérateur ne dispose pas d’un accès au portail web.' }, 403);
      } else {
        await json(route, authPayload(options.role));
      }
      return;
    }
    if (url.pathname === '/v1/me') {
      if (options.meGate) await options.meGate;
      await json(route, overview(options.role));
      return;
    }
    if (url.pathname === '/v1/arrivals') {
      await json(route, arrivalPage(url));
      return;
    }
    if (url.pathname === '/v1/managers') {
      await json(route, managers);
      return;
    }
    if (/^\/v1\/stores\/[^/]+\/portals$/.test(url.pathname)) {
      const storeId = url.pathname.split('/')[3];
      await json(route, portals.filter(({ store_id }) => store_id === storeId));
      return;
    }
    if (/^\/v1\/portals\/[^/]+\/operators$/.test(url.pathname)) {
      await json(route, operators);
      return;
    }
    if (url.pathname === '/v1/admins') {
      await json(route, admins);
      return;
    }

    await json(route, { error_code: 'E2E_UNMOCKED', detail: key }, 404);
  });

  return { requests };
}
