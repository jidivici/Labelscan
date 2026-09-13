describe('authenticated binary image requests', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
    process.env.EXPO_OS = 'android';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('../services/authStorage');
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    delete process.env.EXPO_OS;
  });

  it('refreshes an expired photo token and reads the JPEG as bytes through Expo fetch', async () => {
    const fence = { generation: 1, scopeKey: 'org:actor:portal:trade', signal: new AbortController().signal };
    let token = 'old-token';
    jest.doMock('../services/authStorage', () => ({
      captureActiveSession: jest.fn(async () => fence),
      isSessionFenceCurrent: jest.fn(() => true),
      getToken: jest.fn(async () => token),
      getRefreshToken: jest.fn(async () => 'refresh-token'),
      setTokensForSession: jest.fn(async (_fence, next) => { token = next; return true; }),
      setOperatorContext: jest.fn(),
    }));
    const bytes = new Uint8Array([255, 216, 255, 217]);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/v1/mobile/auth/refresh')) {
        return new Response(JSON.stringify({
          access_token: 'new-token', refresh_token: 'new-refresh',
          user: { role: 'manager', id: 'actor', organization_id: 'org', business_portal_id: 'portal', trade_code: 'poissonnerie' },
        }));
      }
      if ((init?.headers as Record<string, string>).Authorization === 'Bearer old-token') {
        return new Response('{}', { status: 401 });
      }
      return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } });
    });
    const { apiBinaryRequest } = await import('../services/api');
    await expect(apiBinaryRequest('/v1/arrivals/a/image')).resolves.toEqual(bytes);
    expect(fetch).toHaveBeenCalledTimes(3);
    const { fetch: expoFetch } = await import('expo/fetch');
    expect(expoFetch).toHaveBeenLastCalledWith('https://api.example.test/v1/arrivals/a/image', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer new-token' }),
    }));
  });

  it('rejects bytes that finish reading after the initiating session changes', async () => {
    const fence = { generation: 1, scopeKey: 'org:actor:portal:trade', signal: new AbortController().signal };
    let current = true;
    jest.doMock('../services/authStorage', () => ({
      captureActiveSession: jest.fn(async () => fence),
      isSessionFenceCurrent: jest.fn(() => current),
      getToken: jest.fn(async () => 'token'),
    }));
    const response = new Response(new Uint8Array([1]));
    jest.spyOn(response, 'arrayBuffer').mockImplementation(async () => {
      current = false;
      return new ArrayBuffer(1);
    });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const { apiBinaryRequest } = await import('../services/api');
    await expect(apiBinaryRequest('/v1/arrivals/a/image')).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  });
});
