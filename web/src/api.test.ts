import { afterEach, describe, expect, it, vi } from 'vitest';

import { authorizedFetch } from './api';
import { managerFixtureSession } from './fixtures/portalFixtures';

describe('authorizedFetch protected headers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prevents callers from replacing authorization and JSON headers', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await authorizedFetch('/v1/protected', managerFixtureSession, {
      method: 'POST',
      body: JSON.stringify({ safe: true }),
      headers: {
        Authorization: 'Bearer attacker',
        Accept: 'text/html',
        'Content-Type': 'text/plain',
        'X-Client-Feature': 'safe',
      },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${managerFixtureSession.token}`);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-client-feature')).toBe('safe');
  });
});
