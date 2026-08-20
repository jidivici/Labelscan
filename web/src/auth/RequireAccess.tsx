import type { ReactNode } from 'react';
import { Redirect, useLocation, useParams, useSearch } from 'wouter';

import { CAPABILITIES, type Capability } from '../types';
import { canAccessProfession, hasCapability } from './capabilities';
import { useAuth } from './AuthContext';

export function RequireSession({ children }: { children: ReactNode }) {
  const { session, restoring } = useAuth();
  const [location] = useLocation();
  const search = useSearch();
  const { organizationSlug = 'labelscan' } = useParams();

  if (restoring) return <LoadingScreen />;
  if (!session) {
    return <Redirect to={`/o/${organizationSlug}/connexion`} state={{ from: `${location}${search ? `?${search}` : ''}` }} replace />;
  }
  if (!hasCapability(session, CAPABILITIES.WEB_ACCESS)) {
    return <Redirect to={`/o/${organizationSlug}/acces-refuse`} replace />;
  }
  return children;
}

export function RequireCapability({ capability, children }: { capability: Capability; children?: ReactNode }) {
  const { session } = useAuth();
  const { organizationSlug = 'labelscan' } = useParams();
  if (!hasCapability(session, capability)) {
    return <Redirect to={`/o/${organizationSlug}/acces-refuse`} replace />;
  }
  return children ?? null;
}

export function RequireProfession({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const { organizationSlug = 'labelscan', profession = '' } = useParams();
  if (!canAccessProfession(session, profession)) {
    return <Redirect to={`/o/${organizationSlug}/acces-refuse`} replace />;
  }
  return children;
}

function LoadingScreen() {
  return <main className="centered-page" aria-live="polite"><div className="loader" /><p>Chargement du portail…</p></main>;
}
