describe('API access-token refresh', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
    process.env.EXPO_OS = 'android';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    delete process.env.EXPO_OS;
  });

  it('serializes refresh and retries concurrent failed requests once', async () => {
    const fence = {
      generation: 1,
      scopeKey: 'org-1:actor-1:portal-1:poissonnerie',
      signal: new AbortController().signal,
    };
    const setTokensForSession = jest.fn().mockResolvedValue(true);
    const setOperatorContext = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../services/authStorage', () => ({
      captureActiveSession: jest.fn().mockResolvedValue(fence),
      clearSessionTokens: jest.fn(),
      clearUsername: jest.fn(),
      emitUnauthenticated: jest.fn(),
      getRefreshToken: jest.fn().mockResolvedValue('refresh-old'),
      getToken: jest.fn().mockResolvedValue('access-old'),
      isSessionFenceCurrent: jest.fn(() => true),
      setTokensForSession,
      setOperatorContext,
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
          JSON.stringify({
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            user: {
              id: 'actor-1',
              role: 'manager',
              organization_id: 'org-1',
              business_portal_id: 'portal-1',
              trade_code: 'poissonnerie',
            },
          }),
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
    expect(setTokensForSession).toHaveBeenCalledWith(fence, 'access-new', 'refresh-new');
    expect(setOperatorContext).toHaveBeenCalledWith({
      organizationId: 'org-1',
      actorId: 'actor-1',
      businessPortalId: 'portal-1',
      tradeCode: 'poissonnerie',
    });
    const { fetch: expoFetch } = await import('expo/fetch');
    expect(jest.mocked(expoFetch)).toHaveBeenCalled();
    const refreshCall = jest.mocked(expoFetch).mock.calls.find(([url]) =>
      String(url).endsWith('/v1/mobile/auth/refresh'),
    );
    expect(refreshCall?.[1]?.signal).not.toBe(fence.signal);
    expect(refreshCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds a shared refresh with its own timeout', async () => {
    jest.useFakeTimers();
    const fence = {
      generation: 1,
      scopeKey: 'org-1:actor-1:portal-1:poissonnerie',
      signal: new AbortController().signal,
    };
    jest.doMock('../services/authStorage', () => ({
      captureActiveSession: jest.fn().mockResolvedValue(fence),
      clearSessionTokens: jest.fn().mockResolvedValue(undefined),
      clearUsername: jest.fn().mockResolvedValue(undefined),
      emitUnauthenticated: jest.fn(),
      getRefreshToken: jest.fn().mockResolvedValue('refresh-old'),
      getToken: jest.fn().mockResolvedValue('access-old'),
      isSessionFenceCurrent: jest.fn(() => true),
      setTokensForSession: jest.fn(),
      setOperatorContext: jest.fn(),
    }));
    global.fetch = jest.fn((input, init) => {
      if (!String(input).endsWith('/v1/mobile/auth/refresh')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error_code: 'UNAUTHENTICATED' }), { status: 401 }),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as jest.Mock;

    const { apiRequest } = await import('../services/api');
    const request = apiRequest('/v1/protected');
    const rejected = expect(request).rejects.toMatchObject({ status: 401 });
    await jest.advanceTimersByTimeAsync(30_000);

    await rejected;
    jest.useRealTimers();
  });

  it('cannot rotate credentials after the captured session is revoked', async () => {
    const controller = new AbortController();
    const fence = {
      generation: 7,
      scopeKey: 'org-1:actor-1:portal-1:poissonnerie',
      signal: controller.signal,
    };
    let current = true;
    const setTokensForSession = jest.fn().mockResolvedValue(true);
    const clearSessionTokens = jest.fn().mockResolvedValue(undefined);
    const clearUsername = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../services/authStorage', () => ({
      captureActiveSession: jest.fn().mockResolvedValue(fence),
      clearSessionTokens,
      clearUsername,
      emitUnauthenticated: jest.fn(),
      getRefreshToken: jest.fn().mockResolvedValue('refresh-old'),
      getToken: jest.fn().mockResolvedValue('access-old'),
      isSessionFenceCurrent: jest.fn(() => current),
      setTokensForSession,
      setOperatorContext: jest.fn(),
    }));

    let releaseRefresh!: () => void;
    let signalRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    global.fetch = jest.fn(async (input) => {
      if (String(input).endsWith('/v1/mobile/auth/refresh')) {
        signalRefreshStarted();
        await refreshGate;
        return new Response(JSON.stringify({
          access_token: 'must-not-land',
          refresh_token: 'must-not-land',
          user: {
            id: 'actor-1',
            role: 'manager',
            organization_id: 'org-1',
            business_portal_id: 'portal-1',
            trade_code: 'poissonnerie',
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error_code: 'UNAUTHENTICATED' }), { status: 401 });
    }) as jest.Mock;

    const { apiRequest } = await import('../services/api');
    const request = apiRequest('/v1/protected');
    await refreshStarted;
    current = false;
    controller.abort();
    releaseRefresh();

    await expect(request).rejects.toMatchObject({ status: 401 });
    expect(setTokensForSession).not.toHaveBeenCalled();
    expect(clearSessionTokens).not.toHaveBeenCalled();
    expect(clearUsername).not.toHaveBeenCalled();
  });

  it('does not let a late 401 from session A refresh or clear session B', async () => {
    const controller = new AbortController();
    const fenceA = {
      generation: 11,
      scopeKey: 'org-a:actor-a:portal-a:poissonnerie',
      signal: controller.signal,
    };
    let currentGeneration = 11;
    const clearSessionTokens = jest.fn();
    const clearUsername = jest.fn();
    const getRefreshToken = jest.fn().mockResolvedValue('refresh-b');
    jest.doMock('../services/authStorage', () => ({
      captureActiveSession: jest.fn().mockResolvedValue(fenceA),
      clearSessionTokens,
      clearUsername,
      emitUnauthenticated: jest.fn(),
      getRefreshToken,
      getToken: jest.fn().mockResolvedValue('access-a'),
      isSessionFenceCurrent: jest.fn((fence) => fence.generation === currentGeneration),
      setTokensForSession: jest.fn(),
      setOperatorContext: jest.fn(),
    }));

    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    global.fetch = jest.fn(async () => {
      await responseGate;
      return new Response(JSON.stringify({ error_code: 'UNAUTHENTICATED' }), { status: 401 });
    }) as jest.Mock;

    const { apiRequest } = await import('../services/api');
    const oldRequest = apiRequest('/v1/session-a-resource');
    await new Promise((resolve) => setImmediate(resolve));
    currentGeneration = 12;
    controller.abort();
    releaseResponse();

    await expect(oldRequest).rejects.toMatchObject({
      code: 'SESSION_CHANGED',
      retriable: false,
    });
    expect(getRefreshToken).not.toHaveBeenCalled();
    expect(clearSessionTokens).not.toHaveBeenCalled();
    expect(clearUsername).not.toHaveBeenCalled();
  });
});
