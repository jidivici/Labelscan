import { AdminPage } from '../identity/AdminPage';
import { OperatorsPage } from '../identity/OperatorsPage';
import { SuperAdminPage } from '../identity/SuperAdminPage';

export function OperatorsWorkspacePage() {
  return <OperatorsPage />;
}

export function AdminWorkspacePage() {
  return <AdminPage />;
}

export function SuperAdminWorkspacePage() {
  return <SuperAdminPage />;
}

export function AccessDeniedPage() {
  return <main className="centered-page"><div className="access-mark">!</div><h1>Accès non autorisé</h1><p>Votre compte ne dispose pas des droits nécessaires pour consulter cet espace.</p></main>;
}

export function NotFoundPage() {
  return <main className="centered-page"><span className="eyebrow">Erreur 404</span><h1>Page introuvable</h1><p>Cette adresse n’existe pas ou n’est plus disponible.</p></main>;
}
