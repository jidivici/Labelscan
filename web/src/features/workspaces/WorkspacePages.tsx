import { Link, useParams } from 'wouter';

import { useAuth } from '../../auth/AuthContext';
import { hasCapability } from '../../auth/capabilities';
import { CAPABILITIES } from '../../types';
import { AdminPage } from '../identity/AdminPage';
import { SuperAdminPage } from '../identity/SuperAdminPage';

export function AdminWorkspacePage() {
  return <AdminPage />;
}

export function SuperAdminWorkspacePage() {
  return <SuperAdminPage />;
}

export function AccessDeniedPage() {
  const { session } = useAuth();
  const { organizationSlug = 'labelscan' } = useParams();
  const administrationPath = hasCapability(session, CAPABILITIES.ADMIN_WORKSPACE_VIEW)
    ? `/o/${organizationSlug}/administration`
    : `/o/${organizationSlug}`;
  return <section className="centered-page"><div className="access-mark">!</div><h1>Accès non autorisé</h1><p>Cette page ne correspond pas aux droits de ce compte.</p><Link className="button primary" href={administrationPath}>Retour à mon espace</Link></section>;
}

export function NotFoundPage() {
  return <main className="centered-page"><span className="eyebrow">Erreur 404</span><h1>Page introuvable</h1><p>Cette adresse n’existe pas ou n’est plus disponible.</p></main>;
}
