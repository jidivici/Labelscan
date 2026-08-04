import { type FormEvent, useCallback, useEffect, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { createAdmin, deactivateAdmin, listAdmins } from './client';
import {
  ActiveBadge,
  ErrorNotice,
  IdentityEmpty,
  IdentityPanel,
  LoadingState,
  OneTimeGrant,
} from './components';
import type { ActivationGrant, IamUser } from './types';

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'L’opération a échoué.';
}

export function SuperAdminPage() {
  const { session } = useAuth();
  const [admins, setAdmins] = useState<IamUser[]>([]);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [grant, setGrant] = useState<ActivationGrant | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      setAdmins(await listAdmins(session));
      setError('');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setSaving(true);
    setGrant(null);
    try {
      const created = await createAdmin(session, {
        username,
        display_name: displayName,
      });
      setGrant(created);
      setUsername('');
      setDisplayName('');
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  async function disable(admin: IamUser) {
    if (!session) return;
    setSaving(true);
    try {
      await deactivateAdmin(session, admin.id);
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  return <section className="page-stack">
    <header className="page-header">
      <div><span className="eyebrow">Super-administration</span><h1>Administrateurs</h1><p>Cycle de vie des administrateurs limité à votre organisation.</p></div>
      <div className="heading-stat"><strong>{admins.length}</strong><span>administrateur{admins.length > 1 ? 's' : ''}</span></div>
    </header>
    <ErrorNotice message={error} />
    <OneTimeGrant grant={grant} title="Code d’activation administrateur" onDismiss={() => setGrant(null)} />

    <IdentityPanel title="Ajouter un administrateur" description="Aucun mot de passe n’est saisi ici; le compte est créé inactif.">
      <form className="filter-panel" onSubmit={(event) => void submit(event)}>
        <label className="field"><span>Identifiant</span><input required maxLength={254} value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <label className="field"><span>Nom affiché</span><input required maxLength={120} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <button className="button primary" disabled={saving}>Créer l’invitation</button>
      </form>
    </IdentityPanel>

    {loading ? <LoadingState label="Chargement des administrateurs…" /> : admins.length === 0
      ? <IdentityEmpty title="Aucun administrateur" description="Ajoutez un administrateur pour cette organisation." />
      : <IdentityPanel title="Comptes administrateurs" description="La désactivation est réversible en base et n’expose aucun credential.">
        <div className="table-scroll"><table>
          <thead><tr><th>Administrateur</th><th>Statut</th><th>Créé le</th><th>Action</th></tr></thead>
          <tbody>{admins.map((admin) => <tr key={admin.id}>
            <td><strong>{admin.display_name}</strong><br /><small className="subtle">{admin.username}</small></td>
            <td><ActiveBadge active={admin.active} /></td>
            <td>{new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(admin.created_at))}</td>
            <td>{admin.active ? <button className="button secondary" disabled={saving} onClick={() => void disable(admin)}>Désactiver</button> : <span className="subtle">Compte désactivé</span>}</td>
          </tr>)}</tbody>
        </table></div>
      </IdentityPanel>}
  </section>;
}
