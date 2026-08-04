import type { ReactNode } from 'react';

import type { ActivationGrant, IamPortal } from './types';

export function IdentityPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return <section className="data-panel" style={{ padding: 20 }}>
    <header style={{ marginBottom: 18 }}>
      <h2 style={{ margin: 0, fontSize: 19 }}>{title}</h2>
      {description && <p className="subtle" style={{ margin: '5px 0 0', fontSize: 12 }}>{description}</p>}
    </header>
    {children}
  </section>;
}

export function LoadingState({ label }: { label: string }) {
  return <div className="catalog-loading" aria-live="polite">
    <div className="loader" />
    <p>{label}</p>
  </div>;
}

export function ErrorNotice({ message }: { message: string }) {
  return message ? <div className="notice error" role="alert">{message}</div> : null;
}

export function ActiveBadge({ active }: { active: boolean }) {
  return <span className={`status-badge ${active ? '' : 'warning'}`}>
    {active ? 'Actif' : 'Inactif'}
  </span>;
}

export function PortalLabel({ portal }: { portal?: IamPortal }) {
  if (!portal) return <>Portail indisponible</>;
  return <>{portal.profession_name} · {portal.store_name}</>;
}

export function OneTimeGrant({
  grant,
  title,
  onDismiss,
}: {
  grant: ActivationGrant | null;
  title: string;
  onDismiss: () => void;
}) {
  if (!grant) return null;
  return <aside
    role="status"
    aria-live="polite"
    className="future-fields"
    style={{ marginTop: 0 }}
  >
    <strong>{title}</strong>
    <p>Ce code n’est affiché qu’une fois. Transmettez-le par un canal sécurisé avant de fermer ce message.</p>
    <output
      aria-label="Code d’activation à usage unique"
      style={{ display: 'block', margin: '12px 0', overflowWrap: 'anywhere', fontFamily: 'ui-monospace, monospace', fontWeight: 800 }}
    >
      {grant.activation_token}
    </output>
    <small>Expire le {new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(grant.expires_at))}</small>
    <div style={{ marginTop: 12 }}>
      <button className="button secondary" type="button" onClick={onDismiss}>J’ai copié le code</button>
    </div>
  </aside>;
}

export function IdentityEmpty({ title, description }: { title: string; description: string }) {
  return <div className="empty-state">
    <h2>{title}</h2>
    <p>{description}</p>
  </div>;
}
