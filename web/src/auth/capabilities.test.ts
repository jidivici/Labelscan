import { describe, expect, it } from 'vitest';

import { fixtureStores } from '../fixtures/portalFixtures';
import { CAPABILITIES, type AccessOverviewPayload } from '../types';
import { applyAccessOverview, canAccessProfession, hasCapability, sessionFromAuthPayload } from './capabilities';

const baseUser = {
  id: 'user-1',
  username: 'compte.test',
  display_name: 'Compte test',
  store_code: 'PARIS-01',
  organization_id: 'organization-1',
  organization_slug: 'labelscan',
};

const overview: AccessOverviewPayload = {
  user: {
    id: 'user-1',
    username: 'compte.test',
    display_name: 'Compte test',
    role: 'manager',
    store_code: 'PARIS-01',
    active: true,
    created_at: '2026-08-04T10:00:00Z',
    business_portal_ids: ['portal-boucherie'],
  },
  capabilities: ['catalog:read', 'identity:operators:manage'],
  scopes: ['catalog:read', 'identity:operators:manage'],
  stores: [fixtureStores[0]],
  business_portals: [{
    id: 'portal-boucherie',
    store_id: 'store-paris',
    store_code: 'PARIS-01',
    store_name: 'Paris Centre',
    profession_code: 'boucherie',
    profession_name: 'Boucherie',
    name: 'Boucherie Paris Centre',
    active: true,
  }],
};

describe('server-authoritative capability normalization', () => {
  it('does not infer access from the login role', () => {
    const session = sessionFromAuthPayload({
      access_token: 'token',
      expires_in: 900,
      user: { ...baseUser, role: 'manager' },
    });

    expect(session.user.capabilities).toEqual([]);
    expect(session.user.profession_codes).toEqual([]);
    expect(hasCapability(session, CAPABILITIES.WEB_ACCESS)).toBe(false);
  });

  it('derives UI capabilities and professions from /v1/me', () => {
    const bearer = sessionFromAuthPayload({
      access_token: 'token',
      expires_in: 900,
      user: { ...baseUser, role: 'manager' },
    });
    const session = applyAccessOverview(bearer, overview);

    expect(hasCapability(session, CAPABILITIES.WEB_ACCESS)).toBe(true);
    expect(hasCapability(session, CAPABILITIES.ARRIVALS_READ)).toBe(true);
    expect(hasCapability(session, CAPABILITIES.OPERATORS_MANAGE)).toBe(true);
    expect(canAccessProfession(session, 'boucherie')).toBe(true);
    expect(canAccessProfession(session, 'poissonnerie')).toBe(false);
    expect(session.user.accessible_stores).toEqual([fixtureStores[0]]);
  });

  it('ignores inactive portals returned in the overview', () => {
    const bearer = sessionFromAuthPayload({
      access_token: 'token',
      expires_in: 900,
      user: { ...baseUser, role: 'manager' },
    });
    const session = applyAccessOverview(bearer, {
      ...overview,
      business_portals: [{ ...overview.business_portals[0], active: false }],
    });

    expect(session.user.profession_codes).toEqual([]);
    expect(session.user.business_portal_ids).toEqual([]);
  });
});
