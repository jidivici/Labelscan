describe('API access-token refresh', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
  });

  it('serializes refresh and retries concurrent failed requests once', async () => {
    const setTokens = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../services/authStorage', () => ({
      clearSessionTokens: jest.fn(),
      emitUnauthenticated: jest.fn(),
      getRefreshToken: jest.fn().mockResolvedValue('refresh-old'),
      getToken: jest.fn().mockResolvedValue('access-old'),
      setTokens,
    }));

    let resourceCalls = 0;
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    global.fetch = jest.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/mobile/auth/refresh')) {
        refreshCalls += 1;
        await refreshGate;
        return new Response(
          JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new' }),
          { status: 200 },
        );
      }
      resourceCalls += 1;
      if (resourceCalls <= 2) {
        return new Response(JSON.stringify({ error_code: 'UNAUTHENTICATED' }), {
          status: 401,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as jest.Mock;

    const { apiRequest } = await import('../services/api');
    const first = apiRequest<{ ok: boolean }>('/v1/one');
    const second = apiRequest<{ ok: boolean }>('/v1/two');
    await new Promise((resolve) => setImmediate(resolve));
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(refreshCalls).toBe(1);
    expect(resourceCalls).toBe(4);
    expect(setTokens).toHaveBeenCalledWith('access-new', 'refresh-new');
  });
});
