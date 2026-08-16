import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { AuthProvider } from '../auth/AuthContext';
import { managerFixtureSession, superAdminFixtureSession } from '../fixtures/portalFixtures';
import { ApplicationRoutes } from './AppRouter';

function renderAt(path: string, session = managerFixtureSession) {
  const { hook } = memoryLocation({ path });
  return render(<Router hook={hook}><AuthProvider initialSession={session}><ApplicationRoutes /></AuthProvider></Router>);
}

describe('capability based routing', () => {
  it('keeps a manager out of the super-admin workspace', async () => {
    renderAt('/o/labelscan/super-administration');
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Retour à mon espace' })).toHaveAttribute('href', '/o/labelscan');
  });

  it('does not expose the retired operator workspace', async () => {
    renderAt('/o/labelscan/portails/boucherie/operateurs');
    expect(await screen.findByRole('heading', { name: 'Page introuvable' })).toBeInTheDocument();
  });

  it('opens the super-admin workspace for an authorized principal', async () => {
    renderAt('/o/labelscan/super-administration', superAdminFixtureSession);
    expect(await screen.findByRole('heading', { name: 'Administrateurs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nouvel administrateur' })).toBeInTheDocument();
    const navigationElement = screen.getByRole('navigation', { name: 'Navigation principale' });
    const navigation = within(navigationElement);
    expect(navigation.getByRole('link', { name: 'Arrivages' })).toHaveAttribute('href', '/o/labelscan/portails/tous/arrivages');
    expect(navigation.queryByText('Portail', { exact: true })).not.toBeInTheDocument();
    expect(navigation.queryByText('Administration', { exact: true })).not.toBeInTheDocument();
    expect(navigationElement.querySelector('.nav-divider')).toBeNull();
  });

  it('keeps the all-professions arrivals view limited to administrators', async () => {
    renderAt('/o/labelscan/portails/tous/arrivages');
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
  });

  it('uses arrivals as the super-admin home', async () => {
    renderAt('/o/labelscan', superAdminFixtureSession);
    expect(await screen.findByRole('heading', { name: 'Tous les arrivages' })).toBeInTheDocument();
  });
});
