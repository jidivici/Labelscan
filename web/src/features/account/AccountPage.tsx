import { type FormEvent, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { changeMyPassword } from '../identity/client';
import { ErrorNotice, IdentityPanel, PasswordField } from '../identity/components';

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Le mot de passe n’a pas pu être modifié.';
}

function hasPrivilegedPasswordPolicy(value: string): boolean {
  return value.length >= 12
    && /[A-Z]/.test(value)
    && /[a-z]/.test(value)
    && /\d/.test(value)
    && /[^\p{Alphabetic}\p{Number}]/u.test(value);
}

export function AccountPage() {
  const { session, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const privileged = session?.user.role === 'admin' || session?.user.role === 'super_admin';
  const validPassword = privileged ? hasPrivilegedPasswordPolicy(newPassword) : newPassword.length >= 12;
  const valid = currentPassword.length > 0
    && validPassword
    && newPassword === confirmation;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !valid) return;
    setSaving(true);
    setError('');
    try {
      await changeMyPassword(session, currentPassword, newPassword);
      await logout();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return <section className="page-stack account-page">
    <header className="page-header">
      <div><h1>Mon compte</h1><p>Modifiez votre mot de passe personnel.</p></div>
    </header>
    <ErrorNotice message={error} />
    <IdentityPanel title="Changer mon mot de passe" description="Votre mot de passe actuel est obligatoire. Vous devrez ensuite vous reconnecter.">
      <form className="account-password-form" onSubmit={(event) => void submit(event)}>
        <PasswordField label="Mot de passe actuel" value={currentPassword} onChange={setCurrentPassword} minLength={1} autoComplete="current-password" />
        <PasswordField label="Nouveau mot de passe" value={newPassword} onChange={setNewPassword} minLength={12} hint={privileged ? '12 caractères minimum, avec majuscule, minuscule, chiffre et caractère spécial.' : '12 caractères minimum.'} />
        <PasswordField label="Confirmer le nouveau mot de passe" value={confirmation} onChange={setConfirmation} minLength={12} />
        {confirmation && confirmation !== newPassword ? <small className="field-error">Les mots de passe ne correspondent pas.</small> : null}
        <button className="button primary" disabled={saving || !valid}>{saving ? 'Modification…' : 'Modifier le mot de passe'}</button>
      </form>
    </IdentityPanel>
  </section>;
}
