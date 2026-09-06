import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'wouter';

import { useAuth } from '../../auth/AuthContext';
import { ApiProblem } from '../../api';
import { hasCapability } from '../../auth/capabilities';
import {
  clearFieldError,
  FieldError,
  type FieldErrors,
  focusFirstInvalidField,
  useFormCompleteness,
} from '../../components/FormValidation';
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
  const { organizationSlug = 'labelscan' } = useParams();
  const { selectedStoreCode, selectedProfessionCode } = useScope();
  const canManageManagers = hasCapability(session, CAPABILITIES.MANAGER_ASSIGNMENTS_MANAGE);
  const canManagePortals = hasCapability(session, CAPABILITIES.STORES_MANAGE);
  const [overview, setOverview] = useState<IamOverview | null>(null);
  const [managers, setManagers] = useState<IamUser[]>([]);
  const [storePortals, setStorePortals] = useState<IamPortal[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [password, setPassword] = useState('');
  const [selectedPortalId, setSelectedPortalId] = useState('');
  const [storeProfessions, setStoreProfessions] = useState<ProfessionCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [managerPage, setManagerPage] = useState(1);
  const [storePage, setStorePage] = useState(1);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [managerFieldErrors, setManagerFieldErrors] = useState<FieldErrors>({});
  const [storeFieldErrors, setStoreFieldErrors] = useState<FieldErrors>({});
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
  const { formRef: managerFormRef, formIsComplete: managerFormIsComplete } = useFormCompleteness((form) => {
    const values = new FormData(form);
    const submittedUsername = String(values.get('username') ?? '').trim();
    const submittedPassword = String(values.get('password') ?? '');
    const submittedPortalId = String(values.get('new-manager-portal') ?? '');
    return submittedUsername.length > 0 && submittedUsername.length <= 254
      && submittedPassword.length > 0 && submittedPassword.length <= 128
      && scopedPortals.some((portal) => portal.active && portal.id === submittedPortalId);
  });
  const { formRef: storeFormRef, formIsComplete: storeFormIsComplete } = useFormCompleteness((form) => {
    const values = new FormData(form);
    const submittedStoreName = String(values.get('storeName') ?? '').trim();
    const hasProfession = values.getAll('professionCodes')
      .map(String)
      .some((code) => Object.hasOwn(PORTALS, code));
    return submittedStoreName.length > 0 && submittedStoreName.length <= 120 && hasProfession;
  });

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
    } catch (cause) {
      setError(message(cause));
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
    if (!session || !selectedStoreId || !canManagePortals) {
      setStorePortals([]);
      return;
    }
    let active = true;
    listStorePortals(session, selectedStoreId)
      .then((items) => {
        if (!active) return;
        setStorePortals(items);
        setError('');
      })
      .catch((cause) => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [canManagePortals, selectedStoreId, session]);

  async function submitManager(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || saving) return;
    // A new validation attempt belongs to this form: do not leave stale errors
    // visible in the store form above/below it.
    setStoreFieldErrors({});
    const form = event.currentTarget;
    const values = new FormData(form);
    const submittedUsername = String(values.get('username') ?? '').trim();
    const submittedPassword = String(values.get('password') ?? '');
    const submittedPortalId = String(values.get('new-manager-portal') ?? '');
    const nextErrors: FieldErrors = {};
    if (!submittedUsername) nextErrors.username = 'Renseignez un identifiant.';
    else if (submittedUsername.length > 254) nextErrors.username = 'L’identifiant ne peut pas dépasser 254 caractères.';
    if (!submittedPassword) nextErrors.password = 'Renseignez un mot de passe.';
    else if (submittedPassword.length > 128) nextErrors.password = 'Le mot de passe ne peut pas dépasser 128 caractères.';
    if (!scopedPortals.some((portal) => portal.active && portal.id === submittedPortalId)) nextErrors.portal = 'Choisissez un magasin et un métier actifs.';
    if (Object.keys(nextErrors).length > 0) {
      setManagerFieldErrors(nextErrors);
      setError('');
      setSuccess('');
      focusFirstInvalidField(form, Object.keys(nextErrors).map((name) => name === 'portal' ? 'new-manager-portal' : name));
      return;
    }
    setSaving(true);
    setManagerFieldErrors({});
    setSuccess('');
    try {
      await createManager(session, {
        username: submittedUsername,
        password: submittedPassword,
        business_portal_ids: [submittedPortalId],
      });
      form.reset();
      setPassword('');
      setSelectedPortalId('');
      setSuccess('Le compte manager est créé et peut se connecter immédiatement.');
      setError('');
      await load();
    } catch (cause) {
      if (cause instanceof ApiProblem && cause.code === 'USER_ALREADY_EXISTS') {
        setManagerFieldErrors({ username: 'Cet identifiant est déjà utilisé dans ce magasin.' });
        focusFirstInvalidField(form, ['username']);
        setError('');
      } else if (cause instanceof ApiProblem && cause.code === 'PASSWORD_ALREADY_EXISTS') {
        setManagerFieldErrors({ password: 'Ce mot de passe est déjà utilisé dans ce magasin.' });
        focusFirstInvalidField(form, ['password']);
        setError('');
      } else if (cause instanceof ApiProblem && cause.code === 'CREDENTIAL_PAIR_ALREADY_EXISTS') {
        const duplicateMessage = 'Ce couple identifiant et mot de passe existe déjà dans un autre magasin.';
        setManagerFieldErrors({ username: duplicateMessage, password: duplicateMessage });
        focusFirstInvalidField(form, ['username']);
        setError('');
      } else {
        setError(message(cause));
      }
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
    if (!session || saving) return;
    // A new validation attempt belongs to this form: do not leave stale errors
    // visible in the manager form above it.
    setManagerFieldErrors({});
    const form = event.currentTarget;
    const values = new FormData(form);
    const submittedStoreName = String(values.get('storeName') ?? '').trim();
    const submittedProfessions = values.getAll('professionCodes')
      .map(String)
      .filter((code): code is ProfessionCode => Object.hasOwn(PORTALS, code));
    const nextErrors: FieldErrors = {};
    if (!submittedStoreName) nextErrors.storeName = 'Renseignez le nom du magasin.';
    else if (submittedStoreName.length > 120) nextErrors.storeName = 'Le nom du magasin ne peut pas dépasser 120 caractères.';
    if (submittedProfessions.length === 0) nextErrors.professionCodes = 'Choisissez au moins un métier.';
    if (Object.keys(nextErrors).length > 0) {
      setStoreFieldErrors(nextErrors);
      setError('');
      setSuccess('');
      focusFirstInvalidField(form, Object.keys(nextErrors));
      return;
    }
    setSaving(true);
    setStoreFieldErrors({});
    setSuccess('');
    try {
      const created = await createStore(session, {
        name: submittedStoreName,
        profession_codes: [...new Set(submittedProfessions)],
      });
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
          : <form ref={managerFormRef} id="create-manager-form" className="identity-form manager-form" method="post" action="/v1/managers" noValidate aria-busy={saving} onSubmit={(event) => void submitManager(event)}>
          <div className="field"><label htmlFor="new-manager-username">Identifiant</label><input id="new-manager-username" name="username" autoComplete="off" required maxLength={254} aria-invalid={Boolean(managerFieldErrors.username)} aria-describedby={managerFieldErrors.username ? 'new-manager-username-error' : undefined} onInput={() => { clearFieldError(setManagerFieldErrors, 'username'); setError(''); }} /><FieldError id="new-manager-username-error" message={managerFieldErrors.username} /></div>
          <PasswordField id="new-manager-password" name="password" value={password} onChange={setPassword} preserveAutofill error={managerFieldErrors.password} onClearError={() => { clearFieldError(setManagerFieldErrors, 'password'); setError(''); }} />
          <div className="field"><span>Magasin et métier attribués</span><ManagerPortalSelect portals={scopedPortals} selected={selectedPortalId} onChange={(portalId) => { setSelectedPortalId(portalId); clearFieldError(setManagerFieldErrors, 'portal'); setError(''); }} name="new-manager-portal" ariaLabel="Magasin et métier attribués" invalid={Boolean(managerFieldErrors.portal)} describedBy={managerFieldErrors.portal ? 'new-manager-portal-error' : undefined} /><FieldError id="new-manager-portal-error" message={managerFieldErrors.portal} /></div>
          <button className={`button primary ${managerFormIsComplete ? 'is-complete' : 'is-incomplete'}`} type="submit" disabled={saving}>{saving ? 'Création…' : 'Créer le compte'}</button>
        </form>}
      </IdentityPanel>
    }

    {canManagePortals && <IdentityPanel title="Nouveau magasin" description="Ajoutez un magasin et choisissez les métiers réellement utilisés.">
      <form ref={storeFormRef} className="identity-form manager-form" noValidate aria-busy={saving} onSubmit={(event) => void submitStore(event)}>
        <div className="field"><label htmlFor="new-store-name">Nom du magasin</label><input id="new-store-name" name="storeName" required maxLength={120} aria-invalid={Boolean(storeFieldErrors.storeName)} aria-describedby={storeFieldErrors.storeName ? 'new-store-name-error' : undefined} onInput={() => { clearFieldError(setStoreFieldErrors, 'storeName'); setError(''); }} /><FieldError id="new-store-name-error" message={storeFieldErrors.storeName} /></div>
        <fieldset className="choice-fieldset" aria-invalid={Boolean(storeFieldErrors.professionCodes)} aria-describedby={storeFieldErrors.professionCodes ? 'new-store-professions-error' : undefined}><legend>Métiers</legend><div className="portal-choices">
          {(Object.keys(PORTALS) as ProfessionCode[]).map((code) => <label key={code} className="portal-choice">
            <input type="checkbox" name="professionCodes" value={code} data-validation-for="professionCodes" checked={storeProfessions.includes(code)} onChange={(event) => { setStoreProfessions(event.target.checked ? [...storeProfessions, code] : storeProfessions.filter((item) => item !== code)); clearFieldError(setStoreFieldErrors, 'professionCodes'); setError(''); }} />
            <span>{PORTALS[code].label}</span>
          </label>)}
        </div><FieldError id="new-store-professions-error" message={storeFieldErrors.professionCodes} /></fieldset>
        <button className={`button primary ${storeFormIsComplete ? 'is-complete' : 'is-incomplete'}`} type="submit" disabled={saving}>{saving ? 'Ajout…' : 'Ajouter le magasin'}</button>
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
            <td><Link className="store-arrivals-link" href={`/o/${organizationSlug}/portails/tous/arrivages?store=${encodeURIComponent(store.code)}`}><strong>{store.name}</strong><small>Voir les arrivages</small></Link></td>
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
