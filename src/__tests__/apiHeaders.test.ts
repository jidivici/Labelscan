describe('API protected headers', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
    delete process.env.EXPO_OS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
  });

  it('does not let request options replace authentication or integrity headers', async () => {
    const fence = {
      generation: 1,
      scopeKey: 'org-1:actor-1:portal-1:poissonnerie',
      signal: new AbortController().signal,
    };
    jest.doMock('../services/authStorage', () => ({
      captureActiveSession: jest.fn().mockResolvedValue(fence),
      clearSessionTokens: jest.fn(),
      clearUsername: jest.fn(),
      emitUnauthenticated: jest.fn(),
      getRefreshToken: jest.fn().mockResolvedValue(null),
      getToken: jest.fn().mockResolvedValue('trusted-token'),
      isSessionFenceCurrent: jest.fn(() => true),
      setTokensForSession: jest.fn(),
      setOperatorContext: jest.fn(),
    }));
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    global.fetch = fetchMock;

    const { apiRequest } = await import('../services/api');
    await apiRequest('/v1/protected', {
      method: 'POST',
      body: { ok: true },
      correlationId: 'trusted-correlation',
      idempotencyKey: 'trusted-idempotency',
      headers: {
        Authorization: 'Bearer attacker',
        'X-Correlation-Id': 'attacker-correlation',
        'Idempotency-Key': 'attacker-idempotency',
        'Content-Type': 'text/plain',
        'X-Client-Feature': 'safe',
      },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer trusted-token');
    expect(headers.get('x-correlation-id')).toBe('trusted-correlation');
    expect(headers.get('idempotency-key')).toBe('trusted-idempotency');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-client-feature')).toBe('safe');
  });

  it('classifies malformed 2xx JSON as a permanent invalid response', async () => {
    const fence = {
      generation: 1,
      scopeKey: 'org-1:actor-1:portal-1:poissonnerie',
      signal: new AbortController().signal,
    };
    jest.doMock('../services/authStorage', () => ({
      captureActiveSession: jest.fn().mockResolvedValue(fence),
      clearSessionTokens: jest.fn(),
      clearUsername: jest.fn(),
      emitUnauthenticated: jest.fn(),
      getRefreshToken: jest.fn().mockResolvedValue(null),
      getToken: jest.fn().mockResolvedValue('trusted-token'),
      isSessionFenceCurrent: jest.fn(() => true),
      setTokensForSession: jest.fn(),
      setOperatorContext: jest.fn(),
    }));
    global.fetch = jest.fn().mockResolvedValue(
      new Response('{"unterminated":', { status: 200 }),
    );

    const { apiRequest } = await import('../services/api');
    await expect(apiRequest('/v1/broken')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 200,
      retriable: false,
    });
  });

  it('purges username with tokens when an authenticated request is revoked', async () => {
    const fence = {
      generation: 1,
      scopeKey: 'org-1:actor-1:portal-1:poissonnerie',
      signal: new AbortController().signal,
    };
    const clearSessionTokens = jest.fn().mockResolvedValue(undefined);
    const clearUsername = jest.fn().mockResolvedValue(undefined);
    const emitUnauthenticated = jest.fn();
    jest.doMock('../services/authStorage', () => ({
      captureActiveSession: jest.fn().mockResolvedValue(fence),
      clearSessionTokens,
      clearUsername,
      emitUnauthenticated,
      getRefreshToken: jest.fn().mockResolvedValue(null),
      getToken: jest.fn().mockResolvedValue('revoked-token'),
      isSessionFenceCurrent: jest.fn(() => true),
      setTokensForSession: jest.fn(),
      setOperatorContext: jest.fn(),
    }));
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error_code: 'UNAUTHENTICATED' }), { status: 401 }),
    );

    const { apiRequest } = await import('../services/api');
    await expect(apiRequest('/v1/revoked')).rejects.toMatchObject({ status: 401 });
    expect(clearSessionTokens).toHaveBeenCalledTimes(1);
    expect(clearUsername).toHaveBeenCalledTimes(1);
    expect(emitUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('signals revocation immediately but fails non-retriably if native purge fails', async () => {
    const fence = {
      generation: 1,
      scopeKey: 'org-1:actor-1:portal-1:poissonnerie',
      signal: new AbortController().signal,
    };
    let rejectPurge!: (error: Error) => void;
    const clearSessionTokens = jest.fn(() => new Promise<void>((_resolve, reject) => {
      rejectPurge = reject;
    }));
    const emitUnauthenticated = jest.fn();
    jest.doMock('../services/authStorage', () => ({
      captureActiveSession: jest.fn().mockResolvedValue(fence),
      clearSessionTokens,
      clearUsername: jest.fn().mockResolvedValue(undefined),
      emitUnauthenticated,
      getRefreshToken: jest.fn().mockResolvedValue(null),
      getToken: jest.fn().mockResolvedValue('revoked-token'),
      isSessionFenceCurrent: jest.fn(() => true),
      setTokensForSession: jest.fn(),
      setOperatorContext: jest.fn(),
    }));
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error_code: 'UNAUTHENTICATED' }), { status: 401 }),
    );

    const { apiRequest } = await import('../services/api');
    const request = apiRequest('/v1/revoked');
    await new Promise((resolve) => setImmediate(resolve));
    expect(emitUnauthenticated).toHaveBeenCalledTimes(1);
    rejectPurge(new Error('keystore unavailable'));

    await expect(request).rejects.toMatchObject({
      code: 'SECURE_SESSION_PURGE_FAILED',
      retriable: false,
    });
  });
});
