import { expect, test, type Page } from '@playwright/test';

import { installMockBackend, type MockBackend, type TestRole } from './mockBackend';

const loginPath = 'o/labelscan/connexion';

async function login(page: Page, role: Exclude<TestRole, 'operator'>): Promise<MockBackend> {
  const backend = await installMockBackend(page, { role });
  await page.goto(loginPath);
  await page.getByLabel('Identifiant').fill(`${role}@labelscan.test`);
  await page.getByLabel('Mot de passe').fill('mot-de-passe-e2e-solide');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/portails\/poissonnerie\/arrivages/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return backend;
}

async function useNavigationLink(page: Page, name: string) {
  const menuButton = page.getByRole('button', { name: 'Ouvrir le menu' });
  if (await menuButton.isVisible()) await menuButton.click();
  await page.locator('.sidebar-nav a').filter({ hasText: name }).click();
}

test('operator login is denied without rendering protected content', async ({ page }) => {
  const backend = await installMockBackend(page, { role: 'operator', denyLogin: true });
  await page.goto(loginPath);

  const username = page.getByLabel('Identifiant');
  await username.focus();
  await page.keyboard.type('operator@labelscan.test');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Mot de passe')).toBeFocused();
  await page.keyboard.type('mot-de-passe-e2e-solide');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('alert')).toContainText('ne dispose pas d’un accès au portail web');
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.getByText('Choisir un portail')).toHaveCount(0);
  expect(backend.requests.filter((request) => request.startsWith('GET /v1/me'))).toHaveLength(0);
});

test('manager sees assigned portals only and can open their operators', async ({ page }) => {
  await login(page, 'manager');
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(19, 42, 39)');
  const layout = await page.evaluate(() => {
    const root = document.documentElement;
    const tableScroller = document.querySelector<HTMLElement>('.table-scroll');
    return {
      rootWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      bodyWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      tableWidth: tableScroller?.clientWidth ?? 0,
      tableScrollWidth: tableScroller?.scrollWidth ?? 0,
    };
  });
  expect(layout.rootScrollWidth).toBe(layout.rootWidth);
  expect(layout.bodyScrollWidth).toBe(layout.bodyWidth);
  expect(layout.tableScrollWidth).toBeGreaterThan(layout.tableWidth);
  const mobileMenu = page.getByRole('button', { name: 'Ouvrir le menu' });
  if (await mobileMenu.isVisible()) {
    await expect(page.locator('#app-sidebar')).toHaveAttribute('aria-hidden', 'true');
    await mobileMenu.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#app-sidebar')).not.toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.sidebar-brand')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(mobileMenu).toBeFocused();
    await expect(mobileMenu).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#app-sidebar')).toHaveAttribute('aria-hidden', 'true');
  }
  await useNavigationLink(page, 'Portails');

  const cards = page.locator('.portal-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: 'Poissonnerie' })).toHaveCount(1);
  await expect(cards.filter({ hasText: 'Charcuterie–Traiteur' })).toHaveCount(1);
  await expect(cards.filter({ hasText: 'Boucherie' })).toHaveCount(0);

  const fishPortal = cards.filter({ hasText: 'Poissonnerie' });
  await fishPortal.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/portails\/poissonnerie\/arrivages/);
  await useNavigationLink(page, 'Opérateurs');

  await expect(page.getByRole('heading', { name: 'Opérateurs' })).toBeVisible();
  await expect(page.getByText('Océane Martin', { exact: true })).toBeVisible();
  await expect(page.getByText('Boucherie')).toHaveCount(0);
});

test('admin sees three stores, portals, and managers without admin credentials', async ({ page }) => {
  const backend = await login(page, 'admin');
  await useNavigationLink(page, 'Magasins & managers');

  await expect(page.getByRole('heading', { name: 'Magasins et managers' })).toBeVisible();
  const storeSelect = page.getByLabel('Magasin').last();
  await expect(storeSelect.locator('option')).toHaveCount(3);
  const invitePanel = page.locator('.data-panel').filter({ has: page.getByRole('heading', { name: 'Inviter un manager' }) });
  await expect(invitePanel.getByRole('checkbox')).toHaveCount(3);
  for (const manager of ['Marion Poisson', 'Bastien Viande', 'Charlie Traiteur']) {
    await expect(page.getByText(manager)).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Ajouter un administrateur' })).toHaveCount(0);
  await expect(page.getByLabel(/mot de passe/i)).toHaveCount(0);
  await expect(page.getByLabel('Code d’activation à usage unique')).toHaveCount(0);
  expect(backend.requests.some((request) => request.includes('/v1/admins'))).toBe(false);
});

test('super-admin can see administrators and the single combined Charcuterie–Traiteur portal', async ({ page }) => {
  await login(page, 'super_admin');
  await useNavigationLink(page, 'Portails');

  const cards = page.locator('.portal-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.filter({ hasText: 'Charcuterie–Traiteur' })).toHaveCount(1);
  await expect(cards.filter({ hasText: /^Charcuterie$/ })).toHaveCount(0);
  await expect(cards.filter({ hasText: /^Traiteur$/ })).toHaveCount(0);

  await useNavigationLink(page, 'Administrateurs');
  await expect(page.getByRole('heading', { name: 'Administrateurs', exact: true })).toBeVisible();
  await expect(page.getByText('Alice Nord')).toBeVisible();
  await expect(page.getByText('Amine Sud')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ajouter un administrateur' })).toBeVisible();
});

test('professional filters persist in the URL, reach the server, and reset pagination', async ({ page }) => {
  const backend = await login(page, 'manager');
  await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('Page 1 sur 3');
  await page.getByRole('button', { name: /^Filtres/ }).click();
  await page.getByLabel('Espèce / désignation commerciale').fill('saumon atlantique');
  await page.getByLabel('Mode de production').selectOption('farmed');

  const expectedFilters = ['commercial_designation:saumon atlantique', 'production_method:farmed'];
  await expect.poll(() => new URL(page.url()).searchParams.getAll('field_filter')).toEqual(expectedFilters);
  await page.getByRole('button', { name: 'Suivant' }).click();
  await expect(page).toHaveURL(/(?:\?|&)page=2(?:&|$)/);
  await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('Page 2 sur 3');

  await expect.poll(() => backend.requests.some((request) => {
    if (!request.startsWith('GET /v1/arrivals?')) return false;
    const url = new URL(request.slice(4), 'http://e2e.local');
    return url.searchParams.get('limit') === '50'
      && url.searchParams.get('offset') === '50'
      && expectedFilters.every((filter) => url.searchParams.getAll('field_filter').includes(filter));
  })).toBe(true);
});

test('protected content never flashes while the authoritative /v1/me response is pending', async ({ page }) => {
  let releaseMe!: () => void;
  const meGate = new Promise<void>((resolve) => { releaseMe = resolve; });
  const backend = await installMockBackend(page, { role: 'admin', restoreSession: true, meGate });
  await page.goto('o/labelscan/administration');
  await expect.poll(() => backend.requests.some((request) => request.startsWith('GET /v1/me'))).toBe(true);

  await expect(page.getByText('Chargement du portail…')).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Magasins et managers' })).toHaveCount(0);
  await expect(page.getByText('Adèle Admin')).toHaveCount(0);

  releaseMe();
  await expect(page.getByRole('heading', { name: 'Magasins et managers' })).toBeVisible();
});
