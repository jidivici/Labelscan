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

type Requirement = { label: string; met: boolean; touched: boolean };

function PasswordRequirements({ requirements }: { requirements: Requirement[] }) {
  return <section className="password-requirements" aria-label="Critères du nouveau mot de passe" aria-live="polite">
    <div className="password-requirements-heading">
      <strong>Critères de sécurité</strong>
      <span>{requirements.every((item) => item.met) ? 'Tous les critères sont respectés' : 'À compléter'}</span>
    </div>
    <ul>{requirements.map((requirement) => {
      const state = requirement.met ? 'met' : requirement.touched ? 'unmet' : 'pending';
      return <li className={state} key={requirement.label}>
        <span aria-hidden="true">{requirement.met ? '✓' : '•'}</span>
        {requirement.label}
      </li>;
    })}</ul>
  </section>;
}

export function AccountPage() {
  const { session, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const privileged = session?.user.role === 'admin' || session?.user.role === 'super_admin';
  const validPassword = privileged ? hasPrivilegedPasswordPolicy(newPassword) : newPassword.length > 0;
  const valid = currentPassword.length > 0
    && validPassword
    && newPassword === confirmation;
  const passwordRequirements: Requirement[] = [
    { label: '12 caractères minimum', met: newPassword.length >= 12, touched: newPassword.length > 0 },
    { label: 'Une lettre majuscule', met: /[A-Z]/.test(newPassword), touched: newPassword.length > 0 },
    { label: 'Une lettre minuscule', met: /[a-z]/.test(newPassword), touched: newPassword.length > 0 },
    { label: 'Un chiffre', met: /\d/.test(newPassword), touched: newPassword.length > 0 },
    { label: 'Un caractère spécial', met: /[^\p{Alphabetic}\p{Number}]/u.test(newPassword), touched: newPassword.length > 0 },
    { label: 'Les deux nouveaux mots de passe correspondent', met: confirmation.length > 0 && newPassword === confirmation, touched: confirmation.length > 0 },
  ];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const submittedCurrentPassword = String(values.get('currentPassword') ?? '');
    const submittedNewPassword = String(values.get('newPassword') ?? '');
    const submittedConfirmation = String(values.get('newPasswordConfirmation') ?? '');
    const submittedPasswordIsValid = privileged
      ? hasPrivilegedPasswordPolicy(submittedNewPassword)
      : submittedNewPassword.length > 0;
    if (!session
      || !submittedCurrentPassword
      || !submittedPasswordIsValid
      || submittedNewPassword !== submittedConfirmation) return;
    setSaving(true);
    setError('');
    try {
      await changeMyPassword(session, submittedCurrentPassword, submittedNewPassword);
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
      <form id="account-password-change-form" className="account-password-form" method="post" action="/v1/me/password" onSubmit={(event) => void submit(event)}>
        <input id="account-username-autofill" className="sr-only" name="username" type="text" autoComplete="username" value={session?.user.username ?? ''} readOnly tabIndex={-1} aria-hidden="true" />
        <PasswordField id="account-current-password" name="currentPassword" label="Mot de passe actuel" value={currentPassword} onChange={setCurrentPassword} minLength={1} autoComplete="current-password" preserveAutofill />
        <PasswordField
          id="account-new-password"
          name="newPassword"
          label="Nouveau mot de passe"
          value={newPassword}
          onChange={setNewPassword}
          minLength={privileged ? 12 : undefined}
          autoComplete="new-password"
          passwordRules={privileged
            ? 'minlength: 12; maxlength: 128; required: upper; required: lower; required: digit; required: special;'
            : undefined}
          hint={privileged ? '12 caractères minimum, avec majuscule, minuscule, chiffre et caractère spécial.' : undefined}
          preserveAutofill
        />
        {privileged ? <PasswordRequirements requirements={passwordRequirements} /> : null}
        <PasswordField id="account-new-password-confirmation" name="newPasswordConfirmation" label="Confirmer le nouveau mot de passe" value={confirmation} onChange={setConfirmation} minLength={privileged ? 12 : undefined} autoComplete="new-password" preserveAutofill />
        <button className={`button account-password-submit ${valid ? 'is-valid' : 'is-incomplete'}`} disabled={saving || !valid}>{saving ? 'Modification…' : 'Modifier le mot de passe'}</button>
      </form>
    </IdentityPanel>
  </section>;
}
