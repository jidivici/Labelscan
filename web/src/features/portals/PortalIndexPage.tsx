import type { CSSProperties } from 'react';
import { Link, useParams } from 'wouter';

import { useAuth } from '../../auth/AuthContext';
import { canAccessProfession } from '../../auth/capabilities';
import { PORTALS } from '../../portals/registry';

export function PortalIndexPage() {
  const { organizationSlug = 'labelscan' } = useParams();
  const { session } = useAuth();
  const portals = Object.values(PORTALS).filter((portal) => canAccessProfession(session, portal.code));

  return <section className="page-stack">
    <header className="page-header">
      <div><span className="eyebrow">Espaces métier</span><h1>Choisir un portail</h1><p>Accédez aux arrivages correspondant à votre périmètre.</p></div>
    </header>
    {portals.length ? <div className="portal-grid">{portals.map((portal) =>
      <Link
        className="portal-card"
        key={portal.code}
        style={{ '--portal-accent': portal.accent } as CSSProperties}
        to={`/o/${organizationSlug}/portails/${portal.code}/arrivages`}
      >
        <span className="portal-monogram">{portal.initials}</span>
        <span><strong>{portal.label}</strong><small>{portal.description}</small></span>
        <span className="arrow">→</span>
      </Link>,
    )}</div> : <div className="empty-state"><h2>Aucun portail attribué</h2><p>Contactez votre administrateur pour vérifier votre périmètre.</p></div>}
  </section>;
}
