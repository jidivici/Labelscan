import { describe, expect, it } from 'vitest';

import { superAdminFixtureSession } from '../../fixtures/portalFixtures';
import { CAPABILITIES, type Session } from '../../types';
import { postLoginPath } from './LoginPage';

const adminSession: Session = {
  ...superAdminFixtureSession,
  user: {
    ...superAdminFixtureSession.user,
    role: 'admin',
    capabilities: [CAPABILITIES.WEB_ACCESS, CAPABILITIES.ARRIVALS_READ, CAPABILITIES.ADMIN_WORKSPACE_VIEW],
  },
};

describe('post-login navigation', () => {
  it('sends an administrator to the all-professions arrivals page', () => {
    expect(postLoginPath(adminSession, 'labelscan')).toBe('/o/labelscan/portails/tous/arrivages');
  });

  it('always uses arrivals instead of restoring a super-admin URL', () => {
    expect(postLoginPath(adminSession, 'labelscan', '/o/labelscan/super-administration'))
      .toBe('/o/labelscan/portails/tous/arrivages');
  });

  it('escapes the access-denied loop after login', () => {
    expect(postLoginPath(adminSession, 'labelscan', '/o/labelscan/acces-refuse'))
      .toBe('/o/labelscan/portails/tous/arrivages');
  });

  it('always sends a super-admin to arrivals', () => {
    expect(postLoginPath(superAdminFixtureSession, 'labelscan', '/o/labelscan/super-administration'))
      .toBe('/o/labelscan/portails/tous/arrivages');
  });
});
