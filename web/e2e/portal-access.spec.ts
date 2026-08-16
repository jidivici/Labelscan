import { expect, test, type Page } from '@playwright/test';

import { installMockBackend, type MockBackend, type TestRole } from './mockBackend';

const loginPath = 'o/labelscan/connexion';

async function login(page: Page, role: TestRole): Promise<MockBackend> {
  const backend = await installMockBackend(page, { role });
  await page.goto(loginPath);
  await page.getByLabel('Identifiant').fill(`${role}@labelscan.test`);
  await page.getByLabel('Mot de passe').fill('mot-de-passe-e2e-solide');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(role === 'manager'
    ? /\/portails\/poissonnerie\/arrivages/
    : /\/portails\/tous\/arrivages/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return backend;
}

async function openSidebarIfNeeded(page: Page) {
  const menuButton = page.getByRole('button', { name: 'Ouvrir le menu' });
  if (await menuButton.isVisible()) await menuButton.click();
}

async function useNavigationLink(page: Page, name: string) {
  await openSidebarIfNeeded(page);
  await page.locator('.sidebar-nav a').filter({ hasText: name }).click();
}

test('manager sees only the scope returned by the backend', async ({ page }) => {
  const backend = await login(page, 'manager');
  await expect(page.locator('.kpi-strip, .kpi-card')).toHaveCount(0);
  await expect(page.getByText('À contrôler', { exact: true })).toHaveCount(0);
  expect(backend.requests.some((request) => request.includes('status=flagged'))).toBe(false);
  await page.getByRole('button', { name: 'Vue liste' }).click();
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(21, 38, 34)');
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
  await expect(page.locator('.scope-value').filter({ hasText: 'Métier' })).toContainText('Poissonnerie');
  await expect(page.locator('.scope-selectors select')).toHaveCount(0);
  await expect(page.getByText('Opérateurs', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Boucherie')).toHaveCount(0);
});

test('admin sees three stores, portals, managers, and direct account creation', async ({ page }) => {
  const backend = await login(page, 'admin');
  await useNavigationLink(page, 'Équipe & portails');

  await expect(page.getByRole('heading', { name: 'Équipe et magasins' })).toBeVisible();
  await openSidebarIfNeeded(page);
  await expect(page.getByRole('button', { name: /^Métier/ })).toContainText('Tous les métiers');
  if (await page.getByRole('button', { name: 'Fermer le menu' }).isVisible()) await page.keyboard.press('Escape');
  const creationHeadings = await page.locator('.data-panel h2').allTextContents();
  expect(creationHeadings).toContain('Nouveau magasin');
  expect(creationHeadings).toContain('Nouveau manager');
  expect(creationHeadings.indexOf('Nouveau magasin')).toBeLessThan(creationHeadings.indexOf('Nouveau manager'));
  const storeSelect = page.getByLabel('Magasin').last();
  await expect(storeSelect.locator('option')).toHaveCount(3);
  const invitePanel = page.locator('.data-panel').filter({ has: page.getByRole('heading', { name: 'Nouveau manager' }) });
  const storePanel = page.locator('.data-panel').filter({ has: page.getByRole('heading', { name: 'Nouveau magasin' }) });
  const managerPortalTrigger = invitePanel.getByRole('button', { name: 'Magasin et métier attribués' });
  await expect(invitePanel.locator('select[name="new-manager-portal"]')).toHaveCount(0);
  await managerPortalTrigger.click();
  const managerPortalMenu = page.getByRole('listbox', { name: 'Magasin et métier attribués' });
  await expect(managerPortalMenu.getByRole('option')).toHaveCount(4);
  await managerPortalMenu.getByRole('option', { name: 'Marché République · Poissonnerie' }).click();
  await expect(managerPortalTrigger).toContainText('Marché République · Poissonnerie');
  await expect(page.getByRole('button', { name: 'Magasin et métier de manager.poisson' })).toBeVisible();
  await expect(storePanel.getByRole('checkbox')).toHaveCount(3);
  for (const manager of ['manager.poisson', 'manager.viande', 'manager.traiteur']) {
    await expect(page.getByText(manager)).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Nouvel administrateur' })).toHaveCount(0);
  await expect(invitePanel.locator('input[type="password"]')).toBeVisible();
  expect(backend.requests.some((request) => request.includes('/v1/admins'))).toBe(false);
  await openSidebarIfNeeded(page);
  await page.locator('.sidebar-brand').click();
  await expect(page).toHaveURL(/\/portails\/tous\/arrivages/);
});

test('admin can aggregate every profession and use the HBntory-style arrival cards', async ({ page }) => {
  const backend = await login(page, 'admin');
  await openSidebarIfNeeded(page);
  await page.getByRole('button', { name: /^Métier/ }).click();
  await page.getByRole('option', { name: 'Tous les métiers' }).click();

  await expect(page).toHaveURL(/\/portails\/tous\/arrivages/);
  await expect(page.getByRole('heading', { name: 'Tous les arrivages' })).toBeVisible();
  await expect.poll(() => backend.requests.some((request) => {
    if (!request.startsWith('GET /v1/arrivals?')) return false;
    const url = new URL(request.slice(4), 'http://e2e.local');
    return url.searchParams.get('limit') === '50' && !url.searchParams.has('profession');
  })).toBe(true);

  await page.getByRole('button', { name: 'Vue liste' }).click();
  await expect(page.locator('.arrival-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Vue cartes' }).click();
  await expect(page.locator('.arrival-card')).toHaveCount(1);
  await expect(page.locator('.arrival-card')).toContainText('Saumon atlantique');
  await expect(page.locator('.arrival-card')).toContainText('Enregistré le');
  await expect(page.locator('.arrival-card')).toContainText('Lot LOT-1');
  await expect(page.locator('.arrival-card')).toContainText('FAO 27');

  await page.locator('.arrival-card').click();
  await expect(page.getByRole('heading', { name: 'Détail produit' })).toBeVisible();
  await expect(page.getByText('Contrôle visuel conforme')).toBeVisible();
  await expect(page.getByText('Identifiant du lot')).toHaveCount(0);
  await expect(page.getByText('Identifiant d’ingestion')).toHaveCount(0);
  await expect(page.getByText('ingestion-e2e-1')).toHaveCount(0);
  await expect(page.getByText(/Complétude/)).toHaveCount(0);
  await expect(page.getByText('Marion Poisson')).toBeVisible();
  await expect(page.getByText(/Révision/)).toHaveCount(0);
  await expect(page.getByText('étiquette · Validé')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/portails\/tous\/arrivages$/);
  await expect(page.locator('.arrival-card')).toHaveCount(1);
});

test('search accepts spaces and remains independent from filters', async ({ page }) => {
  const backend = await login(page, 'manager');
  const search = page.getByLabel('Rechercher');

  await search.pressSequentially('saumon atlantique');
  await expect(search).toHaveValue('saumon atlantique');
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('saumon atlantique');
  await expect(page.locator('.filter-count')).toHaveCount(0);
  await expect.poll(() => backend.requests.some((request) => {
    if (!request.startsWith('GET /v1/arrivals?')) return false;
    return new URL(request.slice(4), 'http://e2e.local').searchParams.get('q') === 'saumon atlantique';
  })).toBe(true);

  await page.getByRole('button', { name: /^Filtres/ }).click();
  await page.locator('.advanced-filter-panel label.field').filter({ hasText: /^Statut/ }).locator('select').selectOption('registered');
  await expect(page.locator('.filter-count')).toHaveText('1');
  await page.getByRole('button', { name: 'Réinitialiser tous les filtres' }).click();
  await expect(search).toHaveValue('saumon atlantique');
  await expect(page.locator('.filter-count')).toHaveCount(0);
});

test('admin adds a store with a chosen profession and can remove a store', async ({ page }) => {
  const backend = await login(page, 'admin');
  await useNavigationLink(page, 'Équipe & portails');
  const newStorePanel = page.locator('.data-panel').filter({ has: page.getByRole('heading', { name: 'Nouveau magasin' }) });
  await newStorePanel.getByLabel('Nom du magasin').fill('Boutique test');
  await newStorePanel.getByRole('checkbox', { name: 'Boucherie' }).check();
  await newStorePanel.getByRole('button', { name: 'Ajouter le magasin' }).click();
  await expect(page.getByRole('status')).toContainText('magasin a été ajouté');
  expect(backend.requests).toContain('POST /v1/stores');

  const storesPanel = page.locator('.data-panel').filter({ has: page.getByRole('heading', { name: 'Magasins', exact: true }) });
  page.once('dialog', (dialog) => void dialog.accept());
  await storesPanel.getByRole('button', { name: 'Supprimer' }).first().click();
  await expect.poll(() => backend.requests.some((request) => request.startsWith('PATCH /v1/stores/'))).toBe(true);
});

test('super-admin can see administrators and the single combined Charcuterie–Traiteur portal', async ({ page }) => {
  await login(page, 'super_admin');
  await openSidebarIfNeeded(page);
  await page.getByRole('button', { name: /^Métier/ }).click();
  const professionMenu = page.getByRole('listbox', { name: 'Métier' });
  await expect(professionMenu.getByRole('option')).toHaveCount(4);
  await expect(professionMenu.getByRole('option', { name: 'Tous les métiers' })).toHaveCount(1);
  await expect(professionMenu.getByRole('option', { name: 'Charcuterie–Traiteur' })).toHaveCount(1);
  await expect(professionMenu.getByRole('option', { name: /^Charcuterie$/ })).toHaveCount(0);
  await expect(professionMenu.getByRole('option', { name: /^Traiteur$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(professionMenu).toHaveCount(0);
  await page.getByRole('button', { name: /^Magasin/ }).click();
  await expect(page.getByRole('listbox', { name: 'Magasin' })).toBeVisible();
  await expect(page.locator('.scope-selectors select')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await useNavigationLink(page, 'Administrateurs');
  await expect(page.getByRole('heading', { name: 'Administrateurs', exact: true })).toBeVisible();
  await expect(page.getByText('admin.nord')).toBeVisible();
  await expect(page.getByText('admin.sud')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nouvel administrateur' })).toBeVisible();
});

test('super-admin creates an active account with a direct password', async ({ page }) => {
  const backend = await login(page, 'super_admin');
  await useNavigationLink(page, 'Administrateurs');

  const panel = page.locator('.data-panel').filter({ has: page.getByRole('heading', { name: 'Nouvel administrateur' }) });
  await panel.getByLabel('Identifiant').fill('admin.direct');
  await panel.locator('input[type="password"]').fill('Mot-de-passe-direct!');
  await panel.getByRole('button', { name: 'Créer le compte' }).click();

  await expect(page.getByRole('status')).toContainText('peut se connecter immédiatement');
  expect(backend.requests).toContain('POST /v1/admins');
});

test('professional filters persist in the URL, reach the server, and reset pagination', async ({ page }) => {
  const backend = await login(page, 'manager');
  await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('1–50 sur 101');
  await page.getByRole('button', { name: /^Filtres/ }).click();
  await expect(page.getByLabel('Complétude minimale')).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Signalés' })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Enregistrés' })).toHaveCount(1);
  await page.getByLabel('Espèce / désignation commerciale').fill('saumon atlantique');
  await page.getByLabel('Mode de production').selectOption('farmed');

  const expectedFilters = ['commercial_designation:saumon atlantique', 'production_method:farmed'];
  await expect.poll(() => new URL(page.url()).searchParams.getAll('field_filter')).toEqual(expectedFilters);
  await page.getByRole('button', { name: 'Page suivante' }).click();
  await expect(page).toHaveURL(/(?:\?|&)page=2(?:&|$)/);
  await expect(page.getByRole('navigation', { name: 'Pagination' }).getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');

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
  await expect(page.getByRole('heading', { name: 'Équipe et magasins' })).toHaveCount(0);
  await expect(page.getByText('Adèle Admin')).toHaveCount(0);

  releaseMe();
  await expect(page.getByRole('heading', { name: 'Équipe et magasins' })).toBeVisible();
});
