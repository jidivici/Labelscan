import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'wouter';

import { useAuth } from '../../auth/AuthContext';
import {
  createOperator,
  getIamOverview,
  listOperators,
  resetOperatorCredential,
  updateOperator,
} from './client';
import {
  ActiveBadge,
  ErrorNotice,
  IdentityEmpty,
  IdentityPanel,
  LoadingState,
  OneTimeGrant,
  PortalLabel,
} from './components';
import type { ActivationGrant, IamOverview, IamUser } from './types';

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'L’opération a échoué.';
}

export function OperatorsPage() {
  const { session } = useAuth();
  const { profession = '' } = useParams();
  const [overview, setOverview] = useState<IamOverview | null>(null);
  const [selectedPortalId, setSelectedPortalId] = useState('');
  const [operators, setOperators] = useState<IamUser[]>([]);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [grant, setGrant] = useState<ActivationGrant | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const assignedPortals = useMemo(() => overview?.business_portals.filter(
    (portal) => portal.active && session?.user.business_portal_ids.includes(portal.id),
  ) ?? [], [overview, session?.user.business_portal_ids]);
  const portals = useMemo(
    () => assignedPortals.filter((portal) => portal.profession_code === profession),
    [assignedPortals, profession],
  );

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    getIamOverview(session)
      .then((value) => {
        setOverview(value);
        setError('');
      })
      .catch((cause) => setError(message(cause)))
      .finally(() => setLoading(false));
  }, [session]);

  useEffect(() => {
    if (portals.length === 0) {
      setSelectedPortalId('');
      return;
    }
    if (!portals.some((portal) => portal.id === selectedPortalId)) {
      setSelectedPortalId(portals[0].id);
    }
  }, [portals, selectedPortalId]);

  const refresh = useCallback(async (portalId: string) => {
    if (!session || !portalId) return;
    setLoading(true);
    try {
      setOperators(await listOperators(session, portalId));
      setError('');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (selectedPortalId) void refresh(selectedPortalId);
  }, [refresh, selectedPortalId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !selectedPortalId) return;
    setSaving(true);
    setGrant(null);
    try {
      const created = await createOperator(session, selectedPortalId, {
        username,
        display_name: displayName,
      });
      setGrant(created);
      setUsername('');
      setDisplayName('');
      await refresh(selectedPortalId);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(user: IamUser) {
    if (!session || !selectedPortalId) return;
    setSaving(true);
    try {
      await updateOperator(session, selectedPortalId, user.id, { active: !user.active });
      await refresh(selectedPortalId);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  async function reassign(user: IamUser, nextPortalId: string) {
    if (!session || !selectedPortalId || nextPortalId === selectedPortalId) return;
    setSaving(true);
    try {
      await updateOperator(session, selectedPortalId, user.id, {
        business_portal_id: nextPortalId,
      });
      await refresh(selectedPortalId);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  async function reset(user: IamUser) {
    if (!session) return;
    setSaving(true);
    setGrant(null);
    try {
      setGrant(await resetOperatorCredential(session, user.id));
      setError('');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  const selectedPortal = portals.find((portal) => portal.id === selectedPortalId);
  return <section className="page-stack">
    <header className="page-header">
      <div><span className="eyebrow">Espace manager</span><h1>Opérateurs</h1><p>Comptes limités aux portails métier qui vous sont affectés.</p></div>
      <div className="heading-stat"><strong>{operators.length}</strong><span>opérateur{operators.length > 1 ? 's' : ''}</span></div>
    </header>

    <ErrorNotice message={error} />
    {portals.length > 1 && <label className="field" style={{ maxWidth: 420 }}>
      <span>Portail géré</span>
      <select value={selectedPortalId} onChange={(event) => setSelectedPortalId(event.target.value)}>
        {portals.map((portal) => <option key={portal.id} value={portal.id}>{portal.profession_name} · {portal.store_name}</option>)}
      </select>
    </label>}

    <OneTimeGrant grant={grant} title="Code opérateur à usage unique" onDismiss={() => setGrant(null)} />

    <IdentityPanel title="Créer un opérateur" description={selectedPortal ? `Affectation : ${selectedPortal.profession_name} · ${selectedPortal.store_name}` : 'Sélectionnez un portail autorisé.'}>
      <form className="filter-panel" onSubmit={(event) => void submit(event)}>
        <label className="field"><span>Identifiant</span><input required maxLength={254} value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <label className="field"><span>Nom affiché</span><input required maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <button className="button primary" disabled={saving || !selectedPortalId}>Créer et générer le code</button>
      </form>
    </IdentityPanel>

    {loading ? <LoadingState label="Chargement des opérateurs…" /> : operators.length === 0
      ? <IdentityEmpty title="Aucun opérateur" description="Créez le premier compte pour ce portail métier." />
      : <IdentityPanel title={selectedPortal ? `Annuaire · ${selectedPortal.store_name}` : 'Annuaire opérateurs'}>
        <div className="table-scroll"><table>
          <thead><tr><th>Opérateur</th><th>Portail</th><th>Statut</th><th>Réaffectation</th><th>Actions</th></tr></thead>
          <tbody>{operators.map((user) => <tr key={user.id}>
            <td><strong>{user.display_name}</strong><br /><small className="subtle">{user.username}</small></td>
            <td><PortalLabel portal={overview?.business_portals.find((portal) => user.business_portal_ids.includes(portal.id))} /></td>
            <td><ActiveBadge active={user.active} /></td>
            <td><label className="field"><span className="sr-only">Réaffecter {user.display_name}</span><select aria-label={`Réaffecter ${user.display_name}`} value={selectedPortalId} disabled={saving || assignedPortals.length < 2} onChange={(event) => void reassign(user, event.target.value)}>{assignedPortals.map((portal) => <option value={portal.id} key={portal.id}>{portal.profession_name} · {portal.store_name}</option>)}</select></label></td>
            <td><div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button className="button secondary" disabled={saving} onClick={() => void toggle(user)}>{user.active ? 'Désactiver' : 'Réactiver'}</button>
              <button className="button text" disabled={saving} aria-label={`Réinitialiser l’accès de ${user.display_name}`} onClick={() => void reset(user)}>Réinitialiser l’accès</button>
            </div></td>
          </tr>)}</tbody>
        </table></div>
      </IdentityPanel>}
  </section>;
}
