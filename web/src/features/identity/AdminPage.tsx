import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { hasCapability } from '../../auth/capabilities';
import { PORTALS } from '../../portals/registry';
import { useScope } from '../../scope/ScopeContext';
import { CAPABILITIES, type ProfessionCode } from '../../types';
import {
  createStore,
  createManager,
  deleteManager,
  getIamOverview,
  listManagers,
  listStorePortals,
  replaceManagerPortals,
  setStoreActive,
  setStorePortalActive,
} from './client';
import {
  ActiveBadge,
  CompactPager,
  ConfirmDialog,
  ErrorNotice,
  IDENTITY_PAGE_SIZE,
  IdentityEmpty,
  IdentityPanel,
  LoadingState,
  PasswordField,
  SuccessNotice,
} from './components';
import { ManagerPortalSelect, StoreSelect } from './ManagerPortalSelect';
import type { IamOverview, IamPortal, IamUser } from './types';

type StoreItem = IamOverview['stores'][number] & { id: string };

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'L’opération a échoué.';
}

function ManagerRow({
  manager,
  portals,
  saving,
  onAssignments,
  onDelete,
}: {
  manager: IamUser;
  portals: IamPortal[];
  saving: boolean;
  onAssignments: (manager: IamUser, portalIds: string[]) => Promise<boolean>;
  onDelete: (manager: IamUser) => void;
}) {
  const activePortalIds = portals.filter((portal) => portal.active).map((portal) => portal.id);
  const assignedActivePortalId = manager.business_portal_ids.find((id) => activePortalIds.includes(id)) ?? '';
  const [selected, setSelected] = useState(assignedActivePortalId);
  useEffect(() => setSelected(assignedActivePortalId), [assignedActivePortalId]);
  async function changeAssignment(portalId: string) {
    if (!portalId || portalId === assignedActivePortalId) return;
    setSelected(portalId);
    if (!await onAssignments(manager, [portalId])) setSelected(assignedActivePortalId);
  }
  return <tr>
    <td><strong>{manager.username}</strong></td>
    <td><ManagerPortalSelect portals={portals} selected={selected} onChange={(portalId) => void changeAssignment(portalId)} name={`manager-${manager.id}`} ariaLabel={`Magasin et métier de ${manager.username}`} inTable disabled={saving} /></td>
    <td><ActiveBadge active={manager.active} /></td>
    <td><div className="table-actions">
      <button className="button text small danger-text" type="button" disabled={saving} onClick={() => onDelete(manager)}>Supprimer</button>
    </div></td>
  </tr>;
}

export function AdminPage() {
  const { session, refreshAccess } = useAuth();
  const { selectedStoreCode, selectedProfessionCode } = useScope();
  const canManageManagers = hasCapability(session, CAPABILITIES.MANAGER_ASSIGNMENTS_MANAGE);
  const canManagePortals = hasCapability(session, CAPABILITIES.STORES_MANAGE);
  const [overview, setOverview] = useState<IamOverview | null>(null);
  const [managers, setManagers] = useState<IamUser[]>([]);
  const [storePortals, setStorePortals] = useState<IamPortal[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [selectedPortalId, setSelectedPortalId] = useState('');
  const [storeName, setStoreName] = useState('');
  const [storeProfessions, setStoreProfessions] = useState<ProfessionCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [managerPage, setManagerPage] = useState(1);
  const [storePage, setStorePage] = useState(1);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [pendingDeletion, setPendingDeletion] = useState<{ kind: 'manager'; item: IamUser } | { kind: 'store'; item: StoreItem } | null>(null);
  const [deletionError, setDeletionError] = useState('');

  const stores = useMemo(
    () => overview?.stores.filter((store): store is typeof store & { id: string } => Boolean(store.id)) ?? [],
    [overview],
  );
  const portals = overview?.business_portals ?? [];
  const scopedPortals = portals.filter((portal) =>
    (!selectedStoreCode || portal.store_code === selectedStoreCode)
    && (!selectedProfessionCode || portal.profession_code === selectedProfessionCode),
  );
  const scopedPortalIds = new Set(scopedPortals.map((portal) => portal.id));
  const scopedManagers = managers.filter((manager) =>
    (!selectedStoreCode && !selectedProfessionCode)
    || manager.business_portal_ids.some((id) => scopedPortalIds.has(id)),
  );
  const scopedStores = stores.filter((store) =>
    (!selectedStoreCode || store.code === selectedStoreCode)
    && (!selectedProfessionCode || portals.some((portal) => portal.store_code === store.code && portal.profession_code === selectedProfessionCode)),
  );
  const visibleStorePortals = storePortals.filter((portal) =>
    !selectedProfessionCode || portal.profession_code === selectedProfessionCode,
  );
  const managerPageCount = Math.max(1, Math.ceil(scopedManagers.length / IDENTITY_PAGE_SIZE));
  const storePageCount = Math.max(1, Math.ceil(scopedStores.length / IDENTITY_PAGE_SIZE));
  const visibleManagers = scopedManagers.slice((managerPage - 1) * IDENTITY_PAGE_SIZE, managerPage * IDENTITY_PAGE_SIZE);
  const visibleStores = scopedStores.slice((storePage - 1) * IDENTITY_PAGE_SIZE, storePage * IDENTITY_PAGE_SIZE);
  const scopeActive = Boolean(selectedStoreCode || selectedProfessionCode);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const [access, users] = await Promise.all([
        getIamOverview(session),
        canManageManagers ? listManagers(session) : Promise.resolve([]),
      ]);
      setOverview(access);
      setManagers(users);
      setError('');
    } catch {
      setDeletionError('Ce manager ne peut pas être supprimé pour le moment. Vérifiez ses accès, puis réessayez.');
    } finally {
      setLoading(false);
    }
  }, [canManageManagers, session]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (managerPage > managerPageCount) setManagerPage(managerPageCount);
  }, [managerPage, managerPageCount]);

  useEffect(() => {
    if (storePage > storePageCount) setStorePage(storePageCount);
  }, [storePage, storePageCount]);

  useEffect(() => {
    if (scopedStores.some((store) => store.id === selectedStoreId)) return;
    setSelectedStoreId(scopedStores[0]?.id ?? '');
  }, [scopedStores, selectedStoreId]);

  useEffect(() => {
    setManagerPage(1);
    setStorePage(1);
  }, [selectedProfessionCode, selectedStoreCode]);

  useEffect(() => {
    if (selectedPortalId && !scopedPortalIds.has(selectedPortalId)) setSelectedPortalId('');
  }, [scopedPortalIds, selectedPortalId]);

  useEffect(() => {
    if (!session || !selectedStoreId || !canManagePortals) return;
    listStorePortals(session, selectedStoreId)
      .then((items) => {
        setStorePortals(items);
        setError('');
      })
      .catch((cause) => setError(message(cause)));
  }, [canManagePortals, selectedStoreId, session]);

  async function submitManager(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !selectedPortalId) return;
    setSaving(true);
    setSuccess('');
    try {
      await createManager(session, {
        username,
        password,
        business_portal_ids: [selectedPortalId],
      });
      setUsername('');
      setPassword('');
      setSelectedPortalId('');
      setSuccess('Le compte manager est créé et peut se connecter immédiatement.');
      setError('');
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  async function saveAssignments(manager: IamUser, portalIds: string[]): Promise<boolean> {
    if (!session) return false;
    setSaving(true);
    try {
      await replaceManagerPortals(session, manager.id, portalIds);
      await load();
      setSuccess(`L’affectation de ${manager.username} a été mise à jour.`);
      setError('');
      return true;
    } catch (cause) {
      setError(message(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function removeManager(manager: IamUser) {
    if (!session) return;
    setSaving(true);
    setSuccess('');
    try {
      await deleteManager(session, manager.id);
      setManagers((items) => items.filter((item) => item.id !== manager.id));
      setSuccess(`Le manager ${manager.username} a été supprimé. Cet identifiant peut être réutilisé.`);
      setError('');
      await load();
      setPendingDeletion(null);
    } catch {
      setDeletionError('Ce manager ne peut pas être supprimé pour le moment. Vérifiez ses accès, puis réessayez.');
    } finally {
      setSaving(false);
    }
  }

  async function togglePortal(portal: IamPortal) {
    if (!session || !selectedStoreId) return;
    setSaving(true);
    try {
      const updated = await setStorePortalActive(session, selectedStoreId, portal.id, !portal.active);
      setStorePortals((items) => items.map((item) => item.id === updated.id ? updated : item));
      setOverview((value) => value && {
        ...value,
        business_portals: value.business_portals.map((item) => item.id === updated.id ? updated : item),
      });
      setError('');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  async function submitStore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || storeProfessions.length === 0) return;
    setSaving(true);
    setSuccess('');
    try {
      const created = await createStore(session, {
        name: storeName.trim(),
        profession_codes: storeProfessions,
      });
      setStoreName('');
      setStoreProfessions([]);
      if (created.id) setSelectedStoreId(created.id);
      setSuccess('Le magasin a été ajouté avec ses métiers.');
      setError('');
      await refreshAccess();
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  async function toggleStore(store: (typeof stores)[number]) {
    if (!session) return;
    setSaving(true);
    setSuccess('');
    try {
      await setStoreActive(session, store.code, !store.active);
      setSuccess(store.active ? 'Le magasin a été supprimé.' : 'Le magasin a été réactivé.');
      setError('');
      await refreshAccess();
      await load();
      setPendingDeletion(null);
    } catch {
      setDeletionError('Ce magasin ne peut pas être supprimé tant que des managers ou des accès actifs lui sont associés. Retirez d’abord ces affectations.');
    } finally {
      setSaving(false);
    }
  }

  if (loading && !overview) return <LoadingState label="Chargement de l’administration…" />;
  return <section className="page-stack">
    <header className="page-header">
      <div><h1>Équipe et magasins</h1><p>Attribuez un magasin et un métier à chaque manager.</p></div>
      <div className="heading-stat"><strong>{scopedManagers.length}</strong><span>manager{scopedManagers.length > 1 ? 's' : ''}{scopeActive ? ' affichés' : ''}</span></div>
    </header>
    <ErrorNotice message={error} />
    <SuccessNotice message={success} />

    {canManageManagers &&
      <IdentityPanel title="Nouveau manager" description="Le compte sera actif dès sa création.">
        {scopedPortals.length === 0
          ? <IdentityEmpty title={scopeActive ? 'Aucun portail dans ce périmètre' : 'Créez d’abord un magasin'} description={scopeActive ? 'Modifiez le magasin ou le métier sélectionné pour créer un manager.' : 'Ajoutez un magasin et activez au moins un métier avant de créer votre premier manager.'} />
          : <form className="identity-form manager-form" onSubmit={(event) => void submitManager(event)}>
          <label className="field"><span>Identifiant</span><input required maxLength={254} value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <PasswordField value={password} onChange={setPassword} minLength={12} hint="12 caractères minimum." />
          <label className="field"><span>Magasin et métier attribués</span><ManagerPortalSelect portals={scopedPortals} selected={selectedPortalId} onChange={setSelectedPortalId} name="new-manager-portal" ariaLabel="Magasin et métier attribués" /></label>
          <button className="button primary" disabled={saving || !selectedPortalId || password.length < 12}>{saving ? 'Création…' : 'Créer le compte'}</button>
        </form>}
      </IdentityPanel>
    }

    {canManagePortals && <IdentityPanel title="Nouveau magasin" description="Ajoutez un magasin et choisissez les métiers réellement utilisés.">
      <form className="identity-form manager-form" onSubmit={(event) => void submitStore(event)}>
        <label className="field"><span>Nom du magasin</span><input required maxLength={120} value={storeName} onChange={(event) => setStoreName(event.target.value)} /></label>
        <fieldset className="choice-fieldset"><legend>Métiers</legend><div className="portal-choices">
          {(Object.keys(PORTALS) as ProfessionCode[]).map((code) => <label key={code} className="portal-choice">
            <input type="checkbox" checked={storeProfessions.includes(code)} onChange={(event) => setStoreProfessions(event.target.checked ? [...storeProfessions, code] : storeProfessions.filter((item) => item !== code))} />
            <span>{PORTALS[code].label}</span>
          </label>)}
        </div></fieldset>
        <button className="button primary" disabled={saving || !storeName.trim() || storeProfessions.length === 0}>{saving ? 'Ajout…' : 'Ajouter le magasin'}</button>
      </form>
    </IdentityPanel>}

    {canManageManagers && <>
      {scopedManagers.length === 0
        ? <IdentityEmpty title={scopeActive ? 'Aucun manager dans ce périmètre' : 'Aucun manager'} description={scopeActive ? 'Aucun compte ne correspond au magasin et au métier sélectionnés.' : 'Créez un manager et attribuez-lui un magasin et un métier.'} />
        : <IdentityPanel title="Managers" description="Un manager est rattaché à un seul magasin et un seul métier.">
          <div className="table-scroll paged-content" key={`managers-${managerPage}`}><table className="identity-admin-table">
            <thead><tr><th>Identifiant</th><th>Magasin et métier</th><th>Statut</th><th>Actions</th></tr></thead>
            <tbody>{visibleManagers.map((manager) => <ManagerRow key={manager.id} manager={manager} portals={scopedPortals} saving={saving} onAssignments={saveAssignments} onDelete={(item) => { setDeletionError(''); setPendingDeletion({ kind: 'manager', item }); }} />)}</tbody>
          </table></div>
          <CompactPager page={managerPage} total={scopedManagers.length} onChange={setManagerPage} label="des managers" />
        </IdentityPanel>}
    </>}

    {canManagePortals && <>
      <IdentityPanel title="Magasins" description="La suppression conserve l’historique de traçabilité. Un magasin utilisé doit d’abord être libéré de ses accès actifs.">
        <div className="table-scroll paged-content" key={`stores-${storePage}`}><table className="identity-admin-table">
          <thead><tr><th>Magasin</th><th>Statut</th><th>Actions</th></tr></thead>
          <tbody>{visibleStores.map((store) => <tr key={store.id}>
            <td><strong>{store.name}</strong></td>
            <td><ActiveBadge active={store.active} /></td>
            <td><div className="table-actions">
              <button className={`button ${store.active ? 'text danger-text' : 'secondary'} small`} type="button" disabled={saving} onClick={() => { if (store.active) { setDeletionError(''); setPendingDeletion({ kind: 'store', item: store }); } else void toggleStore(store); }}>{store.active ? 'Supprimer' : 'Réactiver'}</button>
            </div></td>
          </tr>)}</tbody>
        </table></div>
        <CompactPager page={storePage} total={scopedStores.length} onChange={setStorePage} label="des magasins" />
      </IdentityPanel>

      <IdentityPanel title="Métiers par magasin" description="Activez uniquement les métiers utilisés dans chaque magasin.">
      <div className="field compact-field panel-control"><span>Magasin</span><StoreSelect stores={scopedStores} selected={selectedStoreId} onChange={setSelectedStoreId} disabled={scopedStores.length === 0} /></div>
      {visibleStorePortals.length === 0
        ? <IdentityEmpty title="Aucun portail" description="Aucun portail métier n’est disponible pour ce magasin." />
        : <div className="table-scroll"><table className="identity-admin-table identity-portal-table">
          <thead><tr><th>Métier</th><th>Statut</th><th>Actions</th></tr></thead>
          <tbody>{visibleStorePortals.map((portal) => <tr key={portal.id}>
            <td><strong>{portal.profession_name}</strong></td>
            <td><ActiveBadge active={portal.active} /></td>
            <td><div className="table-actions"><button className="button secondary small" type="button" disabled={saving} onClick={() => void togglePortal(portal)}>{portal.active ? 'Désactiver' : 'Activer'}</button></div></td>
          </tr>)}</tbody>
        </table></div>}
      </IdentityPanel>
    </>}
    <ConfirmDialog
      open={pendingDeletion !== null}
      title={pendingDeletion?.kind === 'manager' ? 'Supprimer ce manager ?' : 'Supprimer ce magasin ?'}
      description={pendingDeletion?.kind === 'manager'
        ? `Le manager « ${pendingDeletion.item.username} » n’aura plus accès au portail. Son historique restera associé aux étiquettes.`
        : pendingDeletion?.kind === 'store'
          ? `Le magasin « ${pendingDeletion.item.name} » sera désactivé. Son historique de traçabilité sera conservé.`
          : ''}
      error={deletionError}
      busy={saving}
      onClose={() => { setDeletionError(''); setPendingDeletion(null); }}
      onConfirm={() => pendingDeletion?.kind === 'manager' ? removeManager(pendingDeletion.item) : pendingDeletion ? toggleStore(pendingDeletion.item) : Promise.resolve()}
    />
  </section>;
}
