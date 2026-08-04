import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { hasCapability } from '../../auth/capabilities';
import { CAPABILITIES } from '../../types';
import {
  createManager,
  getIamOverview,
  listManagers,
  listStorePortals,
  replaceManagerPortals,
  setManagerActive,
  setStorePortalActive,
} from './client';
import {
  ActiveBadge,
  ErrorNotice,
  IdentityEmpty,
  IdentityPanel,
  LoadingState,
  OneTimeGrant,
} from './components';
import type { ActivationGrant, IamOverview, IamPortal, IamUser } from './types';

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'L’opération a échoué.';
}

function PortalChoices({
  portals,
  selected,
  onChange,
  name,
}: {
  portals: IamPortal[];
  selected: string[];
  onChange: (ids: string[]) => void;
  name: string;
}) {
  return <div style={{ display: 'grid', gap: 8 }}>
    {portals.filter((portal) => portal.active).map((portal) => <label key={portal.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <input
        type="checkbox"
        name={name}
        value={portal.id}
        checked={selected.includes(portal.id)}
        onChange={(event) => onChange(event.target.checked
          ? [...selected, portal.id]
          : selected.filter((id) => id !== portal.id))}
      />
      <span>{portal.profession_name} · {portal.store_name}</span>
    </label>)}
  </div>;
}

function ManagerRow({
  manager,
  portals,
  saving,
  onAssignments,
  onToggle,
}: {
  manager: IamUser;
  portals: IamPortal[];
  saving: boolean;
  onAssignments: (manager: IamUser, portalIds: string[]) => Promise<void>;
  onToggle: (manager: IamUser) => Promise<void>;
}) {
  const activePortalIds = portals.filter((portal) => portal.active).map((portal) => portal.id);
  const assignedActivePortalIds = manager.business_portal_ids.filter((id) => activePortalIds.includes(id));
  const [selected, setSelected] = useState(assignedActivePortalIds);
  useEffect(() => setSelected(assignedActivePortalIds), [manager.business_portal_ids, portals]);
  const changed = selected.slice().sort().join('|') !== manager.business_portal_ids.slice().sort().join('|');
  return <tr>
    <td><strong>{manager.display_name}</strong><br /><small className="subtle">{manager.username}</small></td>
    <td><PortalChoices portals={portals} selected={selected} onChange={setSelected} name={`manager-${manager.id}`} /></td>
    <td><ActiveBadge active={manager.active} /></td>
    <td><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button className="button secondary" disabled={saving || selected.length === 0 || !changed} onClick={() => void onAssignments(manager, selected)}>Enregistrer les portails</button>
      <button className="button text" disabled={saving} onClick={() => void onToggle(manager)}>{manager.active ? 'Désactiver' : 'Réactiver'}</button>
    </div></td>
  </tr>;
}

export function AdminPage() {
  const { session } = useAuth();
  const canManageManagers = hasCapability(session, CAPABILITIES.MANAGER_ASSIGNMENTS_MANAGE);
  const canManagePortals = hasCapability(session, CAPABILITIES.STORES_MANAGE);
  const [overview, setOverview] = useState<IamOverview | null>(null);
  const [managers, setManagers] = useState<IamUser[]>([]);
  const [storePortals, setStorePortals] = useState<IamPortal[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selectedPortalIds, setSelectedPortalIds] = useState<string[]>([]);
  const [grant, setGrant] = useState<ActivationGrant | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const stores = useMemo(
    () => overview?.stores.filter((store): store is typeof store & { id: string } => Boolean(store.id)) ?? [],
    [overview],
  );
  const portals = overview?.business_portals ?? [];

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
    if (!selectedStoreId && stores[0]) setSelectedStoreId(stores[0].id);
  }, [selectedStoreId, stores]);

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
    if (!session || selectedPortalIds.length === 0) return;
    setSaving(true);
    setGrant(null);
    try {
      const created = await createManager(session, {
        username,
        display_name: displayName,
        business_portal_ids: selectedPortalIds,
      });
      setGrant(created);
      setUsername('');
      setDisplayName('');
      setSelectedPortalIds([]);
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  async function saveAssignments(manager: IamUser, portalIds: string[]) {
    if (!session) return;
    setSaving(true);
    try {
      await replaceManagerPortals(session, manager.id, portalIds);
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  async function toggleManager(manager: IamUser) {
    if (!session) return;
    setSaving(true);
    try {
      await setManagerActive(session, manager.id, !manager.active);
      await load();
    } catch (cause) {
      setError(message(cause));
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

  if (loading && !overview) return <LoadingState label="Chargement de l’administration…" />;
  return <section className="page-stack">
    <header className="page-header">
      <div><span className="eyebrow">Administration</span><h1>Magasins et managers</h1><p>Affectations métier séparées de toute gestion de mot de passe.</p></div>
      <div className="heading-stat"><strong>{managers.length}</strong><span>manager{managers.length > 1 ? 's' : ''}</span></div>
    </header>
    <ErrorNotice message={error} />

    {canManageManagers && <>
      <OneTimeGrant grant={grant} title="Code d’activation manager" onDismiss={() => setGrant(null)} />
      <IdentityPanel title="Inviter un manager" description="Le compte reste inactif jusqu’à l’utilisation du code d’activation.">
        <form className="filter-panel" onSubmit={(event) => void submitManager(event)}>
          <label className="field"><span>Identifiant</span><input required maxLength={254} value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label className="field"><span>Nom affiché</span><input required maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="field" style={{ marginBottom: 8 }}>Portails autorisés</legend><PortalChoices portals={portals} selected={selectedPortalIds} onChange={setSelectedPortalIds} name="new-manager-portals" /></fieldset>
          <button className="button primary" disabled={saving || selectedPortalIds.length === 0}>Créer l’invitation</button>
        </form>
      </IdentityPanel>

      {managers.length === 0
        ? <IdentityEmpty title="Aucun manager" description="Invitez un manager et choisissez au moins un portail." />
        : <IdentityPanel title="Affectations managers" description="Une réaffectation révoque les sessions afin de recharger le périmètre.">
          <div className="table-scroll"><table>
            <thead><tr><th>Manager</th><th>Portails autorisés</th><th>Statut</th><th>Actions</th></tr></thead>
            <tbody>{managers.map((manager) => <ManagerRow key={manager.id} manager={manager} portals={portals} saving={saving} onAssignments={saveAssignments} onToggle={toggleManager} />)}</tbody>
          </table></div>
        </IdentityPanel>}
    </>}

    {canManagePortals && <IdentityPanel title="Activation des portails magasin" description="Les trois métiers restent référencés; leur désactivation est réversible et révoque les sessions concernées.">
      <label className="field" style={{ maxWidth: 440, marginBottom: 18 }}><span>Magasin</span><select value={selectedStoreId} onChange={(event) => setSelectedStoreId(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name} · {store.code}</option>)}</select></label>
      {storePortals.length === 0
        ? <IdentityEmpty title="Aucun portail" description="Aucun portail métier n’est disponible pour ce magasin." />
        : <div className="extension-grid">{storePortals.map((portal) => <article className="extension-card" key={portal.id}>
          <span className="extension-dot" />
          <h2>{portal.profession_name}</h2>
          <p>{portal.name}<br />{portal.store_name}</p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}><ActiveBadge active={portal.active} /><button className="button secondary" disabled={saving} onClick={() => void togglePortal(portal)}>{portal.active ? 'Désactiver' : 'Activer'}</button></div>
        </article>)}</div>}
    </IdentityPanel>}
  </section>;
}
