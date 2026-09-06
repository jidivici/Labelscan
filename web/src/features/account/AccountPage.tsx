import { type FormEvent, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  clearFieldError,
  type FieldErrors,
  focusFirstInvalidField,
  hasPrivilegedPasswordPolicy,
  PRIVILEGED_PASSWORD_HINT,
  PRIVILEGED_PASSWORD_RULES,
} from '../../components/FormValidation';
import { changeMyPassword } from '../identity/client';
import { ErrorNotice, IdentityPanel, PasswordField } from '../identity/components';

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Le mot de passe n’a pas pu être modifié.';
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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const privileged = session?.user.role === 'admin' || session?.user.role === 'super_admin';
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
    if (saving) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const submittedCurrentPassword = String(values.get('currentPassword') ?? '');
    const submittedNewPassword = String(values.get('newPassword') ?? '');
    const submittedConfirmation = String(values.get('newPasswordConfirmation') ?? '');
    const submittedPasswordIsValid = privileged
      ? hasPrivilegedPasswordPolicy(submittedNewPassword)
      : submittedNewPassword.length > 0 && submittedNewPassword.length <= 128;
    const nextErrors: FieldErrors = {};
    if (!submittedCurrentPassword) nextErrors.currentPassword = 'Renseignez votre mot de passe actuel.';
    else if (submittedCurrentPassword.length > 128) nextErrors.currentPassword = 'Le mot de passe ne peut pas dépasser 128 caractères.';
    if (!submittedNewPassword) {
      nextErrors.newPassword = 'Renseignez un nouveau mot de passe.';
    } else if (!submittedPasswordIsValid) {
      nextErrors.newPassword = privileged
        ? 'Respectez tous les critères de sécurité indiqués.'
        : 'Le mot de passe ne peut pas dépasser 128 caractères.';
    }
    if (!submittedConfirmation) {
      nextErrors.newPasswordConfirmation = 'Confirmez votre nouveau mot de passe.';
    } else if (submittedNewPassword !== submittedConfirmation) {
      nextErrors.newPasswordConfirmation = 'Les deux nouveaux mots de passe ne correspondent pas.';
    }
    if (!session || Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      setError('');
      focusFirstInvalidField(form, Object.keys(nextErrors));
      return;
    }
    setSaving(true);
    setFieldErrors({});
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
      <form id="account-password-change-form" className="account-password-form" method="post" action="/v1/me/password" noValidate aria-busy={saving} onSubmit={(event) => void submit(event)}>
        <input id="account-username-autofill" className="sr-only" name="username" type="text" autoComplete="username" value={session?.user.username ?? ''} readOnly tabIndex={-1} aria-hidden="true" />
        <PasswordField id="account-current-password" name="currentPassword" label="Mot de passe actuel" value={currentPassword} onChange={setCurrentPassword} minLength={1} autoComplete="current-password" preserveAutofill error={fieldErrors.currentPassword} onClearError={() => { clearFieldError(setFieldErrors, 'currentPassword'); setError(''); }} />
        <PasswordField
          id="account-new-password"
          name="newPassword"
          label="Nouveau mot de passe"
          value={newPassword}
          onChange={setNewPassword}
          minLength={privileged ? 12 : undefined}
          autoComplete="new-password"
          passwordRules={privileged ? PRIVILEGED_PASSWORD_RULES : undefined}
          hint={privileged ? PRIVILEGED_PASSWORD_HINT : undefined}
          preserveAutofill
          error={fieldErrors.newPassword}
          onClearError={() => { clearFieldError(setFieldErrors, 'newPassword'); setError(''); }}
        />
        {privileged ? <PasswordRequirements requirements={passwordRequirements} /> : null}
        <PasswordField id="account-new-password-confirmation" name="newPasswordConfirmation" label="Confirmer le nouveau mot de passe" value={confirmation} onChange={setConfirmation} minLength={privileged ? 12 : undefined} autoComplete="new-password" preserveAutofill error={fieldErrors.newPasswordConfirmation} onClearError={() => { clearFieldError(setFieldErrors, 'newPasswordConfirmation'); setError(''); }} />
        <button className="button primary account-password-submit" type="submit" disabled={saving}>{saving ? 'Modification…' : 'Modifier le mot de passe'}</button>
      </form>
    </IdentityPanel>
  </section>;
}
