(() => {
  'use strict';

  const roleLabels = {
    operator: 'Opérateur',
    admin: 'Administrateur',
  };

  const SESSION_STORAGE_KEY = 'labelscan.web-session.v1';

  const state = {
    token: null,
    currentUser: null,
    sessionExpiresAt: null,
    users: [],
    stores: [],
    catalog: [],
    catalogTotal: 0,
    catalogSearchTimer: null,
    catalogImageObserver: null,
    catalogImageUrls: [],
    catalogImageGeneration: 0,
    catalogRequestId: 0,
  };

  const byId = (id) => document.getElementById(id);
  const elements = {
    loginView: byId('login-view'),
    adminView: byId('admin-view'),
    loginForm: byId('login-form'),
    loginSubmit: byId('login-submit'),
    loginUsername: byId('login-username'),
    loginPassword: byId('login-password'),
    loginError: byId('login-error'),
    pageError: byId('page-error'),
    pageSuccess: byId('page-success'),
    logout: byId('logout-button'),
    sidebar: document.querySelector('.sidebar'),
    sidebarInitials: byId('sidebar-initials'),
    sidebarUserName: byId('sidebar-user-name'),
    sidebarUserRole: byId('sidebar-user-role'),
    portalBrand: byId('portal-brand'),
    usersNav: byId('users-nav'),
    catalogNav: byId('catalog-nav'),
    usersSection: byId('users-section'),
    catalogSection: byId('catalog-section'),
    pageTitle: byId('page-title'),
    adminActions: byId('admin-actions'),
    manageStores: byId('manage-stores-button'),
    createButton: byId('create-user-button'),
    createDialog: byId('create-user-dialog'),
    createForm: byId('create-user-form'),
    createSubmit: byId('create-user-submit'),
    editDialog: byId('edit-user-dialog'),
    editForm: byId('edit-user-form'),
    editSubmit: byId('edit-user-submit'),
    search: byId('users-search'),
    usersFilterToggle: byId('users-filter-toggle'),
    usersFilterPanel: byId('users-filter-panel'),
    usersFilterCount: byId('users-filter-count'),
    usersFilterReset: byId('users-filter-reset'),
    roleFilter: byId('role-filter'),
    statusFilter: byId('status-filter'),
    storeFilter: byId('store-filter'),
    tableBody: byId('users-table-body'),
    usersCount: byId('users-count'),
    lastRefresh: byId('last-refresh'),
    storesDialog: byId('stores-dialog'),
    storesTableBody: byId('stores-table-body'),
    storesError: byId('stores-error'),
    storesSuccess: byId('stores-success'),
    createStoreForm: byId('create-store-form'),
    createStoreSubmit: byId('create-store-submit'),
    catalogSearch: byId('catalog-search'),
    catalogFilterToggle: byId('catalog-filter-toggle'),
    catalogFilterPanel: byId('catalog-filter-panel'),
    catalogFilterCount: byId('catalog-filter-count'),
    catalogFilterReset: byId('catalog-filter-reset'),
    catalogStoreFilter: byId('catalog-store-filter'),
    catalogStoreFilterLabel: byId('catalog-store-filter-label'),
    catalogDateFrom: byId('catalog-date-from'),
    catalogDateTo: byId('catalog-date-to'),
    catalogGrid: byId('catalog-grid'),
    catalogError: byId('catalog-error'),
    catalogCount: byId('catalog-count'),
    catalogTotal: byId('catalog-total'),
    catalogTotalLabel: byId('catalog-total-label'),
    catalogContext: byId('catalog-context'),
    catalogLastRefresh: byId('catalog-last-refresh'),
  };

  function initials(value) {
    return value
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || '—';
  }

  function setNotice(element, message = '') {
    element.textContent = message;
    element.hidden = !message;
  }

  function clearPageNotices() {
    setNotice(elements.pageError);
    setNotice(elements.pageSuccess);
  }

  function clearStoreNotices() {
    setNotice(elements.storesError);
    setNotice(elements.storesSuccess);
  }

  function clearStoredSession() {
    try {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Authentication still works when browser storage is unavailable.
    }
  }

  function persistSession() {
    if (!state.token || !state.currentUser || !state.sessionExpiresAt) return;
    try {
      window.sessionStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          token: state.token,
          currentUser: state.currentUser,
          expiresAt: state.sessionExpiresAt,
        })
      );
    } catch {
      // Keep the in-memory session usable even if storage is blocked or full.
    }
  }

  function readStoredSession() {
    try {
      const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw);
      const validRole = ['admin', 'operator'].includes(session?.currentUser?.role);
      const validStore =
        session?.currentUser?.role !== 'operator' || Boolean(session.currentUser.store_code);
      if (
        typeof session?.token !== 'string' ||
        !session.token ||
        !validRole ||
        !validStore ||
        !Number.isFinite(session?.expiresAt) ||
        session.expiresAt <= Date.now()
      ) {
        clearStoredSession();
        return null;
      }
      return session;
    } catch {
      clearStoredSession();
      return null;
    }
  }

  async function api(path, options = {}) {
    const headers = {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    };
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401 && state.token) {
      signOut('Votre session a expiré. Reconnectez-vous.');
    }
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      const error = new Error(problem.detail || problem.title || 'Une erreur est survenue.');
      error.code = problem.error_code || `HTTP_${response.status}`;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function isAdmin() {
    return state.currentUser?.role === 'admin';
  }

  function closeFilterPanel(toggle, panel) {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  function toggleFilterPanel(toggle, panel) {
    const shouldOpen = panel.hidden;
    panel.hidden = !shouldOpen;
    toggle.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) {
      panel.querySelector('label:not([hidden]) select, label:not([hidden]) input')?.focus();
    }
  }

  function setFilterCount(element, count) {
    element.textContent = String(count);
    element.hidden = count === 0;
  }

  function updateUsersFilterCount() {
    const count = [
      elements.storeFilter.value,
      elements.roleFilter.value,
      elements.statusFilter.value,
    ].filter(Boolean).length;
    setFilterCount(elements.usersFilterCount, count);
  }

  function updateCatalogFilterCount() {
    const count = [
      isAdmin() ? elements.catalogStoreFilter.value : '',
      elements.catalogDateFrom.value,
      elements.catalogDateTo.value,
    ].filter(Boolean).length;
    setFilterCount(elements.catalogFilterCount, count);
  }

  function showPortal() {
    elements.loginView.hidden = true;
    elements.adminView.hidden = false;
    elements.sidebarUserName.textContent = state.currentUser.display_name || state.currentUser.username;
    elements.sidebarUserRole.textContent = isAdmin()
      ? 'Compte admin'
      : `Magasin ${state.currentUser.store_code || 'non affecté'}`;
    elements.sidebarInitials.textContent = initials(
      state.currentUser.display_name || state.currentUser.username
    );
    elements.usersNav.hidden = !isAdmin();
    elements.catalogStoreFilterLabel.hidden = !isAdmin();
    showSection(isAdmin() ? 'users' : 'catalog', false);
  }

  function showSection(section, shouldLoad = true) {
    const usersVisible = section === 'users' && isAdmin();
    elements.usersSection.hidden = !usersVisible;
    elements.catalogSection.hidden = usersVisible;
    elements.adminActions.hidden = !usersVisible;
    elements.usersNav.classList.toggle('nav-item-active', usersVisible);
    elements.catalogNav.classList.toggle('nav-item-active', !usersVisible);
    elements.usersNav.toggleAttribute('aria-current', usersVisible);
    elements.catalogNav.toggleAttribute('aria-current', !usersVisible);
    const sectionTitle = usersVisible ? 'Gestion des utilisateurs' : 'Arrivages';
    elements.pageTitle.textContent = sectionTitle;
    document.title = `${sectionTitle} — LabelScan`;
    if (shouldLoad && !usersVisible) loadCatalog();
  }

  function signOut(message = '') {
    window.clearTimeout(state.catalogSearchTimer);
    resetCatalogImages();
    state.catalogRequestId += 1;
    clearStoredSession();
    state.token = null;
    state.currentUser = null;
    state.sessionExpiresAt = null;
    state.users = [];
    state.stores = [];
    state.catalog = [];
    state.catalogTotal = 0;
    state.catalogSearchTimer = null;
    elements.catalogSearch.value = '';
    elements.catalogStoreFilter.value = '';
    elements.catalogDateFrom.value = '';
    elements.catalogDateTo.value = '';
    elements.search.value = '';
    elements.storeFilter.value = '';
    elements.roleFilter.value = '';
    elements.statusFilter.value = '';
    elements.adminView.hidden = true;
    elements.loginView.hidden = false;
    elements.loginForm.reset();
    closeFilterPanel(elements.usersFilterToggle, elements.usersFilterPanel);
    closeFilterPanel(elements.catalogFilterToggle, elements.catalogFilterPanel);
    setNotice(elements.loginError, message);
    document.title = 'LabelScan — Portail';
    elements.loginUsername.focus();
  }

  function filteredUsers() {
    const query = elements.search.value.trim().toLocaleLowerCase('fr');
    const role = elements.roleFilter.value;
    const status = elements.statusFilter.value;
    const storeCode = elements.storeFilter.value;
    return state.users.filter((user) => {
      const matchesQuery = !query || `${user.display_name} ${user.username} ${user.store_code || ''}`
        .toLocaleLowerCase('fr')
        .includes(query);
      const matchesRole = !role || user.role === role;
      const matchesStore = !storeCode || user.store_code === storeCode;
      const matchesStatus =
        !status ||
        (status === 'active' && user.active) ||
        (status === 'inactive' && !user.active);
      return matchesQuery && matchesRole && matchesStore && matchesStatus;
    });
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(date);
  }

  function textCell(text, className = '') {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = text;
    return cell;
  }

  function actionButton(label, action, user, style = 'secondary') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button button-${style} button-small`;
    button.dataset.action = action;
    button.dataset.userId = user.id;
    button.textContent = label;
    return button;
  }

  function storeActionButton(label, action, store, style = 'secondary') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button button-${style} button-small`;
    button.dataset.storeAction = action;
    button.dataset.storeCode = store.code;
    button.textContent = label;
    return button;
  }

  function populateStoreControls() {
    const configs = [
      [elements.storeFilter, 'Tous les magasins', true],
      [elements.catalogStoreFilter, 'Tous les magasins', true],
      [byId('create-store-code'), 'Sélectionner un magasin', false],
      [byId('edit-store-code'), 'Aucun magasin', true],
    ];
    for (const [select, emptyLabel, includeInactive] of configs) {
      const previous = select.value;
      select.replaceChildren();
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = emptyLabel;
      select.appendChild(empty);
      for (const store of state.stores) {
        if (!includeInactive && !store.active) continue;
        const option = document.createElement('option');
        option.value = store.code;
        option.textContent = `${store.code} — ${store.name}${store.active ? '' : ' (désactivé)'}`;
        const isFilter =
          select === elements.storeFilter ||
          select === elements.catalogStoreFilter;
        option.disabled = !store.active && !isFilter;
        select.appendChild(option);
      }
      if ([...select.options].some((option) => option.value === previous)) {
        select.value = previous;
      }
    }
  }

  function renderStores() {
    elements.storesTableBody.replaceChildren();
    if (!state.stores.length) {
      const row = document.createElement('tr');
      const cell = textCell('Aucun magasin.', 'empty-cell');
      cell.colSpan = 4;
      row.appendChild(cell);
      elements.storesTableBody.appendChild(row);
      return;
    }

    for (const store of state.stores) {
      const row = document.createElement('tr');
      row.appendChild(textCell(store.code, 'store-code-cell'));
      row.appendChild(textCell(store.name));

      const statusCell = document.createElement('td');
      const status = document.createElement('span');
      status.className = `status${store.active ? ' status-active' : ''}`;
      status.textContent = store.active ? 'Actif' : 'Désactivé';
      statusCell.appendChild(status);
      row.appendChild(statusCell);

      const actionsCell = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.append(
        storeActionButton('Renommer', 'rename', store),
        storeActionButton(
          store.active ? 'Désactiver' : 'Réactiver',
          'toggle',
          store,
          store.active ? 'danger' : 'secondary'
        )
      );
      actionsCell.appendChild(actions);
      row.appendChild(actionsCell);
      elements.storesTableBody.appendChild(row);
    }
  }

  async function loadStores() {
    try {
      state.stores = await api('/v1/stores');
      populateStoreControls();
      renderStores();
    } catch (error) {
      state.stores = [];
      populateStoreControls();
      renderStores();
      setNotice(elements.pageError, error.message);
      setNotice(elements.storesError, error.message);
    }
  }

  async function renameStore(store) {
    const name = window.prompt(`Nom du magasin ${store.code}`, store.name);
    if (name === null || !name.trim() || name.trim() === store.name) return;
    clearPageNotices();
    clearStoreNotices();
    try {
      await api(`/v1/stores/${encodeURIComponent(store.code)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() }),
      });
      await loadStores();
      renderUsers();
      setNotice(elements.storesSuccess, 'Le magasin a été renommé.');
    } catch (error) {
      setNotice(elements.storesError, error.message);
    }
  }

  async function toggleStore(store) {
    const verb = store.active ? 'désactiver' : 'réactiver';
    if (!window.confirm(`Voulez-vous ${verb} le magasin « ${store.code} » ?`)) return;
    clearPageNotices();
    clearStoreNotices();
    try {
      await api(`/v1/stores/${encodeURIComponent(store.code)}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !store.active }),
      });
      await loadStores();
      setNotice(
        elements.storesSuccess,
        store.active ? 'Le magasin a été désactivé.' : 'Le magasin a été réactivé.'
      );
    } catch (error) {
      setNotice(elements.storesError, error.message);
    }
  }

  function renderUsers() {
    const users = filteredUsers();
    elements.tableBody.replaceChildren();
    elements.usersCount.textContent = `${users.length} compte${users.length > 1 ? 's' : ''}${
      users.length !== state.users.length ? ` sur ${state.users.length}` : ''
    }`;
    updateUsersFilterCount();

    if (!users.length) {
      const row = document.createElement('tr');
      const cell = textCell(
        state.users.length ? 'Aucun utilisateur ne correspond à ces filtres.' : 'Aucun utilisateur.',
        'empty-cell'
      );
      cell.colSpan = 6;
      row.appendChild(cell);
      elements.tableBody.appendChild(row);
      return;
    }

    for (const user of users) {
      const row = document.createElement('tr');

      const identityCell = document.createElement('td');
      const identity = document.createElement('div');
      identity.className = 'user-identity';
      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.textContent = initials(user.display_name || user.username);
      const identityText = document.createElement('span');
      const displayName = document.createElement('strong');
      displayName.textContent = user.display_name;
      const username = document.createElement('small');
      username.textContent = user.username;
      identityText.append(displayName, username);
      identity.append(avatar, identityText);
      identityCell.appendChild(identity);
      row.appendChild(identityCell);

      const roleCell = document.createElement('td');
      const role = document.createElement('span');
      role.className = `badge badge-${user.role}`;
      role.textContent = roleLabels[user.role] || user.role;
      roleCell.appendChild(role);
      row.appendChild(roleCell);

      const storeCell = document.createElement('td');
      if (user.store_code) {
        const store = state.stores.find((item) => item.code === user.store_code);
        const storeIdentity = document.createElement('span');
        storeIdentity.className = 'store-identity';
        const code = document.createElement('strong');
        code.textContent = user.store_code;
        storeIdentity.appendChild(code);
        if (store) {
          const name = document.createElement('small');
          name.textContent = store.name;
          storeIdentity.appendChild(name);
        }
        storeCell.appendChild(storeIdentity);
      } else {
        storeCell.textContent = '—';
      }
      row.appendChild(storeCell);

      const statusCell = document.createElement('td');
      const status = document.createElement('span');
      status.className = `status${user.active ? ' status-active' : ''}`;
      status.textContent = user.active ? 'Actif' : 'Désactivé';
      statusCell.appendChild(status);
      row.appendChild(statusCell);
      row.appendChild(textCell(formatDate(user.created_at)));

      const actionsCell = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.appendChild(actionButton('Modifier', 'edit', user));
      if (user.id !== state.currentUser.id) {
        actions.appendChild(
          actionButton(
            user.active ? 'Supprimer' : 'Réactiver',
            'toggle',
            user,
            user.active ? 'danger' : 'secondary'
          )
        );
      }
      actionsCell.appendChild(actions);
      row.appendChild(actionsCell);
      elements.tableBody.appendChild(row);
    }
  }

  async function loadUsers() {
    elements.tableBody.innerHTML =
      '<tr><td colspan="6" class="empty-cell">Chargement des utilisateurs…</td></tr>';
    try {
      const page = await api('/v1/users?limit=200&offset=0');
      state.users = page.items;
      elements.lastRefresh.textContent = `Actualisé à ${new Intl.DateTimeFormat('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date())}`;
      renderUsers();
    } catch (error) {
      setNotice(elements.pageError, error.message);
      state.users = [];
      renderUsers();
    }
  }

  function catalogProductName(product) {
    return product.product_name || product.scientific_name || 'Produit sans désignation';
  }

  function catalogStoreName(code) {
    const store = state.stores.find((item) => item.code === code);
    return store ? `${code} — ${store.name}` : code || 'Non affecté';
  }

  function updateCatalogSummary() {
    const selectedStore = isAdmin()
      ? elements.catalogStoreFilter.value
      : state.currentUser.store_code;
    elements.catalogTotal.textContent = String(state.catalogTotal);
    elements.catalogTotalLabel.textContent =
      state.catalogTotal > 1 ? 'arrivages' : 'arrivage';
    elements.catalogContext.textContent = isAdmin()
      ? selectedStore
        ? `Arrivages partagés par ${catalogStoreName(selectedStore)}.`
        : 'Arrivages enregistrés dans tous les magasins.'
      : `Arrivages partagés avec le magasin ${catalogStoreName(state.currentUser.store_code)}.`;
    updateCatalogFilterCount();
  }

  function catalogDetail(label, value) {
    const detail = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value || '—';
    detail.append(term, description);
    return detail;
  }

  function catalogBadge(text, style = '') {
    const badge = document.createElement('span');
    badge.className = `catalog-badge${style ? ` catalog-badge-${style}` : ''}`;
    badge.textContent = text;
    return badge;
  }

  function productionMethodLabel(value) {
    return {
      wild_caught: 'Pêché',
      farmed: 'Élevé',
    }[value] || value;
  }

  function resetCatalogImages() {
    state.catalogImageGeneration += 1;
    state.catalogImageObserver?.disconnect();
    state.catalogImageObserver = null;
    for (const url of state.catalogImageUrls) URL.revokeObjectURL(url);
    state.catalogImageUrls = [];
  }

  async function loadCatalogImage(image, generation) {
    try {
      const response = await fetch(
        `/v1/arrivals/${encodeURIComponent(image.dataset.arrivalImage)}/image`,
        {
          headers: {
            Accept: 'image/*',
            Authorization: `Bearer ${state.token}`,
          },
        }
      );
      if (response.status === 401) {
        signOut('Votre session a expiré. Reconnectez-vous.');
        return;
      }
      if (!response.ok) throw new Error('Photo indisponible');
      const url = URL.createObjectURL(await response.blob());
      if (generation !== state.catalogImageGeneration || !image.isConnected) {
        URL.revokeObjectURL(url);
        return;
      }
      state.catalogImageUrls.push(url);
      image.addEventListener('load', () => {
        image.hidden = false;
        image.nextElementSibling.hidden = true;
      }, { once: true });
      image.addEventListener('error', () => {
        const label = image.nextElementSibling.querySelector('span');
        if (label) label.textContent = 'Photo indisponible';
      }, { once: true });
      image.src = url;
    } catch {
      const label = image.nextElementSibling.querySelector('span');
      if (label) label.textContent = 'Photo indisponible';
    }
  }

  function observeCatalogImages() {
    const images = [...elements.catalogGrid.querySelectorAll('[data-arrival-image]')];
    if (!images.length) return;
    const generation = state.catalogImageGeneration;
    if (!('IntersectionObserver' in window)) {
      for (const image of images) loadCatalogImage(image, generation);
      return;
    }
    state.catalogImageObserver = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          loadCatalogImage(entry.target, generation);
        }
      },
      { rootMargin: '200px 0px' }
    );
    for (const image of images) state.catalogImageObserver.observe(image);
  }

  function renderCatalog() {
    resetCatalogImages();
    elements.catalogGrid.replaceChildren();
    elements.catalogCount.textContent = `${state.catalog.length} arrivage${
      state.catalog.length > 1 ? 's' : ''
    } affiché${state.catalog.length > 1 ? 's' : ''} sur ${state.catalogTotal}`;
    updateCatalogSummary();

    if (!state.catalog.length) {
      const empty = document.createElement('div');
      empty.className = 'catalog-state';
      empty.textContent = 'Aucun arrivage ne correspond à cette recherche.';
      elements.catalogGrid.appendChild(empty);
      return;
    }

    for (const product of state.catalog) {
      const card = document.createElement('article');
      card.className = 'product-card';

      const media = document.createElement('div');
      media.className = 'product-card-media';
      const photo = document.createElement('img');
      photo.className = 'product-card-photo';
      photo.alt = `Étiquette de ${catalogProductName(product)}`;
      photo.dataset.arrivalImage = product.batch_id;
      photo.hidden = true;
      const placeholder = document.createElement('div');
      placeholder.className = 'product-card-placeholder';
      const placeholderLogo = document.createElement('img');
      placeholderLogo.src = './assets/labelscan-logo.png';
      placeholderLogo.alt = '';
      const placeholderLabel = document.createElement('span');
      placeholderLabel.textContent = 'Chargement de la photo…';
      placeholder.append(placeholderLogo, placeholderLabel);
      media.append(photo, placeholder);

      const header = document.createElement('div');
      header.className = 'product-card-header';
      const identity = document.createElement('div');
      identity.className = 'product-card-identity';
      const name = document.createElement('strong');
      name.textContent = catalogProductName(product);
      const reference = document.createElement('span');
      reference.className = 'product-reference';
      reference.textContent = `Lot ${product.lot_code}`;
      identity.append(name, reference);
      if (
        product.scientific_name &&
        product.scientific_name !== catalogProductName(product)
      ) {
        const scientificName = document.createElement('small');
        scientificName.textContent = product.scientific_name;
        identity.appendChild(scientificName);
      }

      const recordedAt = document.createElement('time');
      recordedAt.className = 'product-card-date';
      recordedAt.dateTime = product.recorded_at;
      recordedAt.textContent = formatDate(product.recorded_at);
      recordedAt.title = 'Date d’enregistrement';
      header.append(identity, recordedAt);

      const details = document.createElement('dl');
      details.className = 'product-card-details';
      details.append(
        catalogDetail('Fournisseur', product.supplier_name),
        catalogDetail('DLC', formatDate(product.use_by))
      );
      if (product.packaging_date) {
        details.appendChild(
          catalogDetail('Conditionné le', formatDate(product.packaging_date))
        );
      }

      const footer = document.createElement('footer');
      footer.className = 'product-card-footer';
      if (isAdmin()) {
        footer.appendChild(catalogBadge(catalogStoreName(product.store_code), 'store'));
      }
      if (product.gtin) {
        footer.appendChild(catalogBadge(`GTIN ${product.gtin}`));
      }
      if (product.fao_area_code) {
        footer.appendChild(catalogBadge(`FAO ${product.fao_area_code}`));
      }
      if (product.production_method) {
        footer.appendChild(
          catalogBadge(productionMethodLabel(product.production_method), 'primary')
        );
      }

      card.append(media, header, details);
      if (footer.childElementCount) card.appendChild(footer);
      elements.catalogGrid.appendChild(card);
    }
    observeCatalogImages();
  }

  async function loadCatalog() {
    const requestId = ++state.catalogRequestId;
    setNotice(elements.catalogError);
    resetCatalogImages();
    const loading = document.createElement('div');
    loading.className = 'catalog-state';
    loading.textContent = 'Chargement des arrivages…';
    elements.catalogGrid.replaceChildren(loading);
    const params = new URLSearchParams({ limit: '200', offset: '0' });
    const query = elements.catalogSearch.value.trim();
    if (query) params.set('q', query);
    if (elements.catalogDateFrom.value) {
      params.set('date_from', elements.catalogDateFrom.value);
    }
    if (elements.catalogDateTo.value) {
      params.set('date_to', elements.catalogDateTo.value);
    }
    if (isAdmin() && elements.catalogStoreFilter.value) {
      params.set('store_code', elements.catalogStoreFilter.value);
    }
    try {
      const page = await api(`/v1/arrivals?${params.toString()}`);
      if (requestId !== state.catalogRequestId) return;
      state.catalog = page.items;
      state.catalogTotal = page.total;
      elements.catalogLastRefresh.textContent = `Actualisé à ${new Intl.DateTimeFormat('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date())}`;
      renderCatalog();
    } catch (error) {
      if (requestId !== state.catalogRequestId) return;
      state.catalog = [];
      state.catalogTotal = 0;
      renderCatalog();
      setNotice(elements.catalogError, error.message);
    }
  }

  function openCreateDialog() {
    clearPageNotices();
    elements.createForm.reset();
    byId('create-role').value = 'operator';
    byId('create-store-code').value = '';
    syncStoreRequirement('create-role', 'create-store-code');
    elements.createDialog.showModal();
    byId('create-display-name').focus();
  }

  function openEditDialog(user) {
    clearPageNotices();
    elements.editForm.reset();
    byId('edit-user-id').value = user.id;
    byId('edit-user-eyebrow').textContent = user.username;
    byId('edit-display-name').value = user.display_name;
    byId('edit-role').value = user.role;
    byId('edit-active').value = String(user.active);
    byId('edit-store-code').value = user.store_code || '';
    const self = user.id === state.currentUser.id;
    byId('edit-role').disabled = self;
    byId('edit-active').disabled = self;
    syncStoreRequirement('edit-role', 'edit-store-code');
    byId('self-account-note').hidden = !self;
    elements.editDialog.showModal();
    byId('edit-display-name').focus();
  }

  function syncStoreRequirement(roleId, storeId) {
    const store = byId(storeId);
    store.required = byId(roleId).value === 'operator';
  }

  async function toggleUser(user) {
    const verb = user.active ? 'supprimer' : 'réactiver';
    if (!window.confirm(`Voulez-vous ${verb} le compte « ${user.display_name} » ?`)) return;
    clearPageNotices();
    try {
      if (user.active) {
        await api(`/v1/users/${user.id}`, { method: 'DELETE' });
      } else {
        await api(`/v1/users/${user.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ active: true }),
        });
      }
      await loadUsers();
      setNotice(
        elements.pageSuccess,
        user.active ? 'Le compte a été supprimé.' : 'Le compte a été réactivé.'
      );
    } catch (error) {
      setNotice(elements.pageError, error.message);
    }
  }

  elements.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setNotice(elements.loginError);
    elements.loginSubmit.disabled = true;
    try {
      const result = await api('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: elements.loginUsername.value.trim(),
          password: elements.loginPassword.value,
        }),
      });
      if (!['admin', 'operator'].includes(result.user.role)) {
        throw new Error('Ce portail est réservé aux utilisateurs LabelScan.');
      }
      if (result.user.role === 'operator' && !result.user.store_code) {
        throw new Error('Votre compte doit être associé à un magasin.');
      }
      state.token = result.access_token;
      state.currentUser = result.user;
      state.sessionExpiresAt = Date.now() + result.expires_in * 1000;
      persistSession();
      elements.loginPassword.value = '';
      showPortal();
      if (isAdmin()) {
        await loadStores();
        await loadUsers();
      } else {
        await loadCatalog();
      }
    } catch (error) {
      setNotice(elements.loginError, error.message);
    } finally {
      elements.loginSubmit.disabled = false;
    }
  });

  elements.logout.addEventListener('click', () => signOut());
  elements.portalBrand.addEventListener('click', (event) => {
    event.preventDefault();
    showSection(isAdmin() ? 'users' : 'catalog');
  });
  elements.usersNav.addEventListener('click', (event) => {
    event.preventDefault();
    if (isAdmin()) showSection('users');
  });
  elements.catalogNav.addEventListener('click', (event) => {
    event.preventDefault();
    showSection('catalog');
  });
  elements.manageStores.addEventListener('click', () => {
    clearPageNotices();
    clearStoreNotices();
    renderStores();
    elements.storesDialog.showModal();
  });
  elements.createButton.addEventListener('click', openCreateDialog);
  elements.usersFilterToggle.addEventListener('click', () => {
    toggleFilterPanel(elements.usersFilterToggle, elements.usersFilterPanel);
  });
  elements.catalogFilterToggle.addEventListener('click', () => {
    toggleFilterPanel(elements.catalogFilterToggle, elements.catalogFilterPanel);
  });
  elements.usersFilterReset.addEventListener('click', () => {
    elements.storeFilter.value = '';
    elements.roleFilter.value = '';
    elements.statusFilter.value = '';
    renderUsers();
  });
  elements.catalogFilterReset.addEventListener('click', () => {
    elements.catalogStoreFilter.value = '';
    elements.catalogDateFrom.value = '';
    elements.catalogDateTo.value = '';
    loadCatalog();
  });
  elements.search.addEventListener('input', renderUsers);
  elements.roleFilter.addEventListener('change', renderUsers);
  elements.statusFilter.addEventListener('change', renderUsers);
  elements.storeFilter.addEventListener('change', renderUsers);
  elements.catalogSearch.addEventListener('input', () => {
    window.clearTimeout(state.catalogSearchTimer);
    state.catalogSearchTimer = window.setTimeout(loadCatalog, 250);
  });
  elements.catalogStoreFilter.addEventListener('change', loadCatalog);
  elements.catalogDateFrom.addEventListener('change', loadCatalog);
  elements.catalogDateTo.addEventListener('change', loadCatalog);
  byId('create-role').addEventListener('change', () => {
    syncStoreRequirement('create-role', 'create-store-code');
  });
  byId('edit-role').addEventListener('change', () => {
    syncStoreRequirement('edit-role', 'edit-store-code');
  });

  document.addEventListener('click', (event) => {
    const closeButton = event.target.closest('[data-close-dialog]');
    if (closeButton) {
      byId(closeButton.dataset.closeDialog).close();
      return;
    }
    const storeAction = event.target.closest('[data-store-action]');
    if (storeAction) {
      const store = state.stores.find(
        (item) => item.code === storeAction.dataset.storeCode
      );
      if (!store) return;
      if (storeAction.dataset.storeAction === 'rename') renameStore(store);
      if (storeAction.dataset.storeAction === 'toggle') toggleStore(store);
      return;
    }
    const actionButtonElement = event.target.closest('[data-action]');
    if (!actionButtonElement) return;
    const user = state.users.find((item) => item.id === actionButtonElement.dataset.userId);
    if (!user) return;
    if (actionButtonElement.dataset.action === 'edit') openEditDialog(user);
    if (actionButtonElement.dataset.action === 'toggle') toggleUser(user);
  });

  elements.createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearPageNotices();
    elements.createSubmit.disabled = true;
    try {
      const storeCode = byId('create-store-code').value;
      await api('/v1/users', {
        method: 'POST',
        body: JSON.stringify({
          display_name: byId('create-display-name').value.trim(),
          username: byId('create-username').value.trim(),
          password: byId('create-password').value,
          role: byId('create-role').value,
          ...(storeCode ? { store_code: storeCode } : {}),
        }),
      });
      elements.createDialog.close();
      await loadUsers();
      setNotice(elements.pageSuccess, 'Le compte utilisateur a été créé.');
    } catch (error) {
      setNotice(elements.pageError, error.message);
      elements.createDialog.close();
    } finally {
      elements.createSubmit.disabled = false;
    }
  });

  elements.createStoreForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearPageNotices();
    clearStoreNotices();
    elements.createStoreSubmit.disabled = true;
    try {
      await api('/v1/stores', {
        method: 'POST',
        body: JSON.stringify({
          code: byId('create-store-code-value').value,
          name: byId('create-store-name').value,
        }),
      });
      elements.createStoreForm.reset();
      await loadStores();
      setNotice(elements.storesSuccess, 'Le magasin a été ajouté.');
    } catch (error) {
      setNotice(elements.storesError, error.message);
    } finally {
      elements.createStoreSubmit.disabled = false;
    }
  });

  elements.editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearPageNotices();
    elements.editSubmit.disabled = true;
    const userId = byId('edit-user-id').value;
    const self = userId === state.currentUser.id;
    const payload = {
      display_name: byId('edit-display-name').value.trim(),
      ...(!self
        ? {
            role: byId('edit-role').value,
            active: byId('edit-active').value === 'true',
          }
        : {}),
      ...(byId('edit-store-code').value
        ? { store_code: byId('edit-store-code').value }
        : {}),
      ...(byId('edit-password').value ? { password: byId('edit-password').value } : {}),
    };
    try {
      const updated = await api(`/v1/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      if (self) {
        state.currentUser = { ...state.currentUser, display_name: updated.display_name };
        persistSession();
        elements.sidebarUserName.textContent = updated.display_name;
        elements.sidebarInitials.textContent = initials(updated.display_name);
      }
      elements.editDialog.close();
      await loadUsers();
      setNotice(elements.pageSuccess, 'Les modifications ont été enregistrées.');
    } catch (error) {
      setNotice(elements.pageError, error.message);
      elements.editDialog.close();
    } finally {
      elements.editSubmit.disabled = false;
    }
  });

  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  async function restoreSession() {
    const session = readStoredSession();
    if (!session) return;
    state.token = session.token;
    state.currentUser = session.currentUser;
    state.sessionExpiresAt = session.expiresAt;
    showPortal();
    if (isAdmin()) {
      await loadStores();
      if (state.token) await loadUsers();
    } else {
      await loadCatalog();
    }
  }

  restoreSession();
})();
