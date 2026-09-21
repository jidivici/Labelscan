import { type FormEvent, useState } from 'react';
import { useLocation, useParams } from 'wouter';

import { ApiProblem } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { firstAccessibleProfession, hasCapability } from '../../auth/capabilities';
import { BrandMark } from '../../BrandMark';
import {
  clearFieldError,
  FieldError,
  type FieldErrors,
  focusFirstInvalidField,
  useFormCompleteness,
} from '../../components/FormValidation';
import { CAPABILITIES, type Session } from '../../types';

export function postLoginPath(session: Session, organizationSlug: string, _requestedPath?: string): string {
  const profession = firstAccessibleProfession(session);
  return hasCapability(session, CAPABILITIES.ADMIN_WORKSPACE_VIEW)
    ? `/o/${organizationSlug}/portails/tous/arrivages`
    : profession
      ? `/o/${organizationSlug}/portails/${profession}/arrivages`
      : `/o/${organizationSlug}/portails`;
}

export function LoginPage() {
  const { organizationSlug = 'labelscan' } = useParams();
  const { login } = useAuth();
  const [, navigate] = useLocation();
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const { formRef, formIsComplete } = useFormCompleteness((form) => {
    const values = new FormData(form);
    const username = String(values.get('username') ?? '').trim();
    const password = String(values.get('password') ?? '');
    return username.length > 0 && username.length <= 254
      && password.length > 0 && password.length <= 128;
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const username = String(values.get('username') ?? '').trim();
    const password = String(values.get('password') ?? '');
    const nextErrors: FieldErrors = {};
    if (!username) nextErrors.username = 'Renseignez votre identifiant.';
    else if (username.length > 254) nextErrors.username = 'L’identifiant ne peut pas dépasser 254 caractères.';
    if (!password) nextErrors.password = 'Renseignez votre mot de passe.';
    else if (password.length > 128) nextErrors.password = 'Le mot de passe ne peut pas dépasser 128 caractères.';
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      setError('');
      focusFirstInvalidField(form, Object.keys(nextErrors));
      return;
    }
    setBusy(true);
    setFieldErrors({});
    setError('');
    try {
      const session = await login(
        organizationSlug,
        username,
        password,
      );
      const from = (window.history.state as { from?: string } | null)?.from;
      navigate(postLoginPath(session, organizationSlug, from), { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiProblem || cause instanceof Error ? cause.message : 'Connexion impossible');
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-page">
    <section className="login-panel">
      <form ref={formRef} className="login-form" noValidate aria-busy={busy} onSubmit={submit}>
        <div className="login-brand"><BrandMark /><div><strong>LabelScan</strong><span>Portail professionnel</span></div></div>
        <header><h1>Connexion</h1><p>Accédez à votre espace de traçabilité.</p></header>
        <div className="field">
          <label htmlFor="login-username">Identifiant</label>
          <input
            id="login-username"
            name="username"
            autoComplete="username"
            maxLength={254}
            required
            aria-invalid={Boolean(fieldErrors.username)}
            aria-describedby={fieldErrors.username ? 'login-username-error' : undefined}
            onInput={() => { clearFieldError(setFieldErrors, 'username'); setError(''); }}
          />
          <FieldError id="login-username-error" message={fieldErrors.username} />
        </div>
        <div className="field">
          <label htmlFor="login-password">Mot de passe</label>
          <span className="password-input">
            <input
              id="login-password"
              name="password"
              type={passwordVisible ? 'text' : 'password'}
              autoComplete="current-password"
              maxLength={128}
              required
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby={fieldErrors.password ? 'login-password-error' : undefined}
              onInput={() => { clearFieldError(setFieldErrors, 'password'); setError(''); }}
            />
            <button
              type="button"
              onClick={() => setPasswordVisible((visible) => !visible)}
              aria-label={passwordVisible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
              aria-pressed={passwordVisible}
            >
              {passwordVisible ? 'Masquer' : 'Afficher'}
            </button>
          </span>
          <FieldError id="login-password-error" message={fieldErrors.password} />
        </div>
        <div className="login-feedback">
          {error && <div className="notice error login-error" role="alert">{error}</div>}
        </div>
        <button className={`button primary wide ${formIsComplete ? 'is-complete' : 'is-incomplete'}`} type="submit" disabled={busy}>{busy ? 'Connexion…' : 'Se connecter'}</button>
      </form>
    </section>
  </main>;
}
