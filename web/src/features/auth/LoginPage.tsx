import { type FormEvent, useState } from 'react';
import { useLocation, useParams } from 'wouter';

import { ApiProblem } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { firstAccessibleProfession } from '../../auth/capabilities';
import { BrandMark } from '../../BrandMark';

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
      const profession = firstAccessibleProfession(session);
      const fallback = profession
        ? `/o/${organizationSlug}/portails/${profession}/arrivages`
        : `/o/${organizationSlug}/portails`;
      navigate(from?.startsWith('/o/') ? from : fallback, { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiProblem || cause instanceof Error ? cause.message : 'Connexion impossible');
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-page">
    <section className="login-visual" aria-label="LabelScan">
      <div className="login-brand">
        <BrandMark />
        <div><strong>LabelScan</strong><span>Portail professionnel</span></div>
      </div>
      <div className="login-promise">
        <span className="eyebrow light">Traçabilité métier</span>
        <h1>Chaque arrivage.<br />Une preuve fiable.</h1>
        <p>Centralisez vos contrôles et retrouvez les informations utiles de chaque rayon.</p>
      </div>
    </section>
    <section className="login-panel">
      <form className="login-form" onSubmit={submit}>
        <div className="mobile-login-brand"><BrandMark /><strong>LabelScan</strong></div>
        <span className="eyebrow">Espace sécurisé</span>
        <h2>Connexion</h2>
        <p className="subtle">Utilisez les identifiants associés à votre établissement.</p>
        {error && <div className="notice error" role="alert">{error}</div>}
        <label className="field">Identifiant<input name="username" autoComplete="username" required autoFocus /></label>
        <label className="field">Mot de passe<input name="password" type="password" autoComplete="current-password" minLength={12} maxLength={128} required /></label>
        <button className="button primary wide" disabled={busy}>{busy ? 'Connexion…' : 'Se connecter'}</button>
      </form>
    </section>
  </main>;
}
