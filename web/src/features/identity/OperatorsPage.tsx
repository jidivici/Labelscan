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
  CompactPager,
  ErrorNotice,
  IDENTITY_PAGE_SIZE,
  IdentityEmpty,
  IdentityPanel,
  LoadingState,
  PasswordDialog,
  PasswordField,
  PortalLabel,
  SuccessNotice,
} from './components';
import type { IamOverview, IamUser } from './types';

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
  const [password, setPassword] = useState('');
  const [resetUser, setResetUser] = useState<IamUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [operatorPage, setOperatorPage] = useState(1);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

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
    setOperatorPage(1);
    if (selectedPortalId) void refresh(selectedPortalId);
  }, [refresh, selectedPortalId]);

  const operatorPageCount = Math.max(1, Math.ceil(operators.length / IDENTITY_PAGE_SIZE));
  const visibleOperators = operators.slice((operatorPage - 1) * IDENTITY_PAGE_SIZE, operatorPage * IDENTITY_PAGE_SIZE);

  useEffect(() => {
    if (operatorPage > operatorPageCount) setOperatorPage(operatorPageCount);
  }, [operatorPage, operatorPageCount]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !selectedPortalId) return;
    setSaving(true);
    setSuccess('');
    try {
      await createOperator(session, selectedPortalId, {
        username,
        password,
      });
      setUsername('');
      setPassword('');
      setSuccess('Le compte opérateur est créé et peut se connecter immédiatement.');
      setError('');
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

  async function reset(newPassword: string) {
    if (!session || !resetUser) return;
    setSaving(true);
    try {
      await resetOperatorCredential(session, resetUser.id, newPassword);
      setSuccess(`Le mot de passe de ${resetUser.username} a été mis à jour.`);
      setError('');
      setResetUser(null);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  const selectedPortal = portals.find((portal) => portal.id === selectedPortalId);
  return <section className="page-stack">
    <header className="page-header">
      <div><h1>Opérateurs</h1><p>Gérez les accès de l’équipe pour ce portail.</p></div>
      <div className="heading-stat"><strong>{operators.length}</strong><span>opérateur{operators.length > 1 ? 's' : ''}</span></div>
    </header>

    <ErrorNotice message={error} />
    <SuccessNotice message={success} />
    {portals.length > 1 && <label className="field compact-field">
      <span>Portail géré</span>
      <select value={selectedPortalId} onChange={(event) => setSelectedPortalId(event.target.value)}>
        {portals.map((portal) => <option key={portal.id} value={portal.id}>{portal.profession_name} · {portal.store_name}</option>)}
      </select>
    </label>}

    <IdentityPanel title="Nouvel opérateur" description={selectedPortal ? `${selectedPortal.profession_name} · ${selectedPortal.store_name}` : 'Sélectionnez un portail.'}>
      <form className="identity-form" onSubmit={(event) => void submit(event)}>
        <label className="field"><span>Identifiant</span><input required maxLength={254} value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <PasswordField value={password} onChange={setPassword} minLength={1} />
        <button className="button primary" disabled={saving || !selectedPortalId || password.length === 0}>{saving ? 'Création…' : 'Créer le compte'}</button>
      </form>
    </IdentityPanel>

    {loading ? <LoadingState label="Chargement des opérateurs…" /> : operators.length === 0
      ? <IdentityEmpty title="Aucun opérateur" description="Créez le premier compte pour ce portail métier." />
      : <IdentityPanel title={selectedPortal ? `Annuaire · ${selectedPortal.store_name}` : 'Annuaire opérateurs'}>
        <div className="table-scroll paged-content" key={`operators-${operatorPage}`}><table>
          <thead><tr><th>Identifiant</th><th>Portail</th><th>Statut</th><th>Actions</th></tr></thead>
          <tbody>{visibleOperators.map((user) => <tr key={user.id}>
            <td><strong>{user.username}</strong></td>
            <td><PortalLabel portal={overview?.business_portals.find((portal) => user.business_portal_ids.includes(portal.id))} /></td>
            <td><ActiveBadge active={user.active} /></td>
            <td><div className="table-actions">
              <button className="button secondary small" type="button" disabled={saving} onClick={() => void toggle(user)}>{user.active ? 'Désactiver' : 'Réactiver'}</button>
              <button className="button text small" type="button" disabled={saving || !user.active} onClick={() => setResetUser(user)}>Mot de passe</button>
            </div></td>
          </tr>)}</tbody>
        </table></div>
        <CompactPager page={operatorPage} total={operators.length} onChange={setOperatorPage} label="des opérateurs" />
      </IdentityPanel>}
    <PasswordDialog user={resetUser} busy={saving} onClose={() => setResetUser(null)} onSubmit={reset} />
  </section>;
}
