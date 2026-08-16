import { type FormEvent, useState } from 'react';
import { useLocation, useParams } from 'wouter';

import { ApiProblem } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { firstAccessibleProfession, hasCapability } from '../../auth/capabilities';
import { BrandMark } from '../../BrandMark';
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
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const session = await login(
        organizationSlug,
        String(values.get('username') ?? ''),
        String(values.get('password') ?? ''),
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
      <form className="login-form" onSubmit={submit}>
        <div className="login-brand"><BrandMark /><div><strong>LabelScan</strong><span>Portail professionnel</span></div></div>
        <header><h1>Connexion</h1><p>Accédez à votre espace de traçabilité.</p></header>
        {error && <div className="notice error" role="alert">{error}</div>}
        <label className="field">Identifiant<input name="username" autoComplete="username" required autoFocus /></label>
        <label className="field">Mot de passe<input name="password" type="password" autoComplete="current-password" maxLength={128} required /></label>
        <button className="button primary wide" disabled={busy}>{busy ? 'Connexion…' : 'Se connecter'}</button>
      </form>
    </section>
  </main>;
}
