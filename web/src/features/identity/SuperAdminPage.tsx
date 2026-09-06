import { type FormEvent, useCallback, useEffect, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  clearFieldError,
  FieldError,
  type FieldErrors,
  focusFirstInvalidField,
  hasPrivilegedPasswordPolicy,
  PRIVILEGED_PASSWORD_ERROR,
  PRIVILEGED_PASSWORD_HINT,
  PRIVILEGED_PASSWORD_RULES,
  useFormCompleteness,
} from '../../components/FormValidation';
import { createAdmin, deactivateAdmin, listAdmins } from './client';
import {
  ActiveBadge,
  CompactPager,
  ErrorNotice,
  IDENTITY_PAGE_SIZE,
  IdentityEmpty,
  IdentityPanel,
  LoadingState,
  PasswordField,
  SuccessNotice,
} from './components';
import type { IamUser } from './types';

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'L’opération a échoué.';
}

export function SuperAdminPage() {
  const { session } = useAuth();
  const [admins, setAdmins] = useState<IamUser[]>([]);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [adminPage, setAdminPage] = useState(1);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const { formRef, formIsComplete } = useFormCompleteness((form) => {
    const values = new FormData(form);
    const submittedUsername = String(values.get('username') ?? '').trim();
    const submittedPassword = String(values.get('password') ?? '');
    return submittedUsername.length > 0 && submittedUsername.length <= 254
      && hasPrivilegedPasswordPolicy(submittedPassword);
  });

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

  const adminPageCount = Math.max(1, Math.ceil(admins.length / IDENTITY_PAGE_SIZE));
  const visibleAdmins = admins.slice((adminPage - 1) * IDENTITY_PAGE_SIZE, adminPage * IDENTITY_PAGE_SIZE);

  useEffect(() => {
    if (adminPage > adminPageCount) setAdminPage(adminPageCount);
  }, [adminPage, adminPageCount]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || saving) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const submittedUsername = String(values.get('username') ?? '').trim();
    const submittedPassword = String(values.get('password') ?? '');
    const nextErrors: FieldErrors = {};
    if (!submittedUsername) nextErrors.username = 'Renseignez un identifiant.';
    else if (submittedUsername.length > 254) nextErrors.username = 'L’identifiant ne peut pas dépasser 254 caractères.';
    if (!submittedPassword) nextErrors.password = 'Renseignez un mot de passe.';
    else if (!hasPrivilegedPasswordPolicy(submittedPassword)) nextErrors.password = PRIVILEGED_PASSWORD_ERROR;
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      setError('');
      setSuccess('');
      focusFirstInvalidField(form, Object.keys(nextErrors));
      return;
    }
    setSaving(true);
    setFieldErrors({});
    setSuccess('');
    try {
      await createAdmin(session, {
        username: submittedUsername,
        password: submittedPassword,
      });
      form.reset();
      setPassword('');
      setSuccess('Le compte administrateur est créé et peut se connecter immédiatement.');
      setError('');
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
      <div><h1>Administrateurs</h1><p>Gérez les personnes autorisées à administrer l’organisation.</p></div>
      <div className="heading-stat"><strong>{admins.length}</strong><span>administrateur{admins.length > 1 ? 's' : ''}</span></div>
    </header>
    <ErrorNotice message={error} />
    <SuccessNotice message={success} />

    <IdentityPanel title="Nouvel administrateur" description="Le compte sera actif dès sa création.">
      <form ref={formRef} id="create-admin-form" className="identity-form" method="post" action="/v1/admins" noValidate aria-busy={saving} onSubmit={(event) => void submit(event)}>
        <div className="field"><label htmlFor="new-admin-username">Identifiant</label><input id="new-admin-username" name="username" autoComplete="off" required maxLength={254} aria-invalid={Boolean(fieldErrors.username)} aria-describedby={fieldErrors.username ? 'new-admin-username-error' : undefined} onInput={() => { clearFieldError(setFieldErrors, 'username'); setError(''); }} /><FieldError id="new-admin-username-error" message={fieldErrors.username} /></div>
        <PasswordField
          id="new-admin-password"
          name="password"
          value={password}
          onChange={setPassword}
          minLength={12}
          passwordRules={PRIVILEGED_PASSWORD_RULES}
          hint={PRIVILEGED_PASSWORD_HINT}
          preserveAutofill
          error={fieldErrors.password}
          onClearError={() => { clearFieldError(setFieldErrors, 'password'); setError(''); }}
        />
        <button className={`button primary ${formIsComplete ? 'is-complete' : 'is-incomplete'}`} type="submit" disabled={saving}>{saving ? 'Création…' : 'Créer le compte'}</button>
      </form>
    </IdentityPanel>

    {loading ? <LoadingState label="Chargement des administrateurs…" /> : admins.length === 0
      ? <IdentityEmpty title="Aucun administrateur" description="Ajoutez un administrateur pour cette organisation." />
      : <IdentityPanel title="Comptes administrateurs" description="Suspendez un compte qui ne doit plus accéder au portail.">
        <div className="table-scroll paged-content" key={`admins-${adminPage}`}><table>
          <thead><tr><th>Identifiant</th><th>Statut</th><th>Créé le</th><th>Action</th></tr></thead>
          <tbody>{visibleAdmins.map((admin) => <tr key={admin.id}>
            <td><strong>{admin.username}</strong></td>
            <td><ActiveBadge active={admin.active} /></td>
            <td>{new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(admin.created_at))}</td>
            <td>{admin.active ? <button className="button secondary small" type="button" disabled={saving} onClick={() => void disable(admin)}>Désactiver</button> : <span className="subtle">Aucune action</span>}</td>
          </tr>)}</tbody>
        </table></div>
        <CompactPager page={adminPage} total={admins.length} onChange={setAdminPage} label="des administrateurs" />
      </IdentityPanel>}
  </section>;
}
