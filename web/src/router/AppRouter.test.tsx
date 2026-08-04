import { render, screen } from '@testing-library/react';
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
  });

  it('keeps a manager out of a profession outside their assignments', async () => {
    renderAt('/o/labelscan/portails/boucherie/operateurs');
    expect(await screen.findByRole('heading', { name: 'Accès non autorisé' })).toBeInTheDocument();
  });

  it('opens the super-admin workspace for an authorized principal', async () => {
    renderAt('/o/labelscan/super-administration', superAdminFixtureSession);
    expect(await screen.findByRole('heading', { name: 'Administrateurs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ajouter un administrateur' })).toBeInTheDocument();
  });
});
