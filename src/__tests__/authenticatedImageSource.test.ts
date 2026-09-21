describe('authenticated image source', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
    process.env.EXPO_OS = 'ios';
  });

  afterEach(() => {
    jest.dontMock('react');
    jest.dontMock('../services/authStorage');
    jest.dontMock('../services/remoteArticlePhoto');
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    delete process.env.EXPO_OS;
  });

  it('only trusts URLs below the exact configured API base', async () => {
    const { isTrustedApiImageUri } = await import('../hooks/useAuthenticatedImageSource');

    expect(isTrustedApiImageUri('https://api.example.test/v1/arrivals/a/image')).toBe(true);
    expect(isTrustedApiImageUri('https://api.example.test')).toBe(true);
    expect(isTrustedApiImageUri('https://api.example.test.evil/v1/image')).toBe(false);
    expect(isTrustedApiImageUri('https://evil.example/v1/image')).toBe(false);
    expect(isTrustedApiImageUri('file:///private/photo.jpg')).toBe(false);
  });

  it('keeps the bearer volatile and updates the source after token rotation', async () => {
    let listener: ((token: string | null) => void) | undefined;
    let cleanup: (() => void) | undefined;
    let currentState: unknown;
    const setState = jest.fn((next: unknown) => {
      currentState = next;
    });
    jest.doMock('react', () => ({
      useState: () => [currentState, setState],
      useEffect: (effect: () => void | (() => void)) => {
        cleanup = effect() ?? undefined;
      },
    }));
    jest.doMock('../services/authStorage', () => ({
      getToken: jest.fn().mockResolvedValue('token-old'),
      onAccessTokenChanged: jest.fn((callback: (token: string | null) => void) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      }),
    }));

    const { useAuthenticatedImageSource } = await import('../hooks/useAuthenticatedImageSource');
    useAuthenticatedImageSource('https://api.example.test/v1/arrivals/a/image');
    await Promise.resolve();
    await Promise.resolve();
    expect(setState).toHaveBeenLastCalledWith({
      requestedUri: 'https://api.example.test/v1/arrivals/a/image',
      source: {
        uri: 'https://api.example.test/v1/arrivals/a/image',
        headers: { Authorization: 'Bearer token-old' },
      },
    });

    listener?.('token-new');
    expect(setState).toHaveBeenLastCalledWith({
      requestedUri: 'https://api.example.test/v1/arrivals/a/image',
      source: {
        uri: 'https://api.example.test/v1/arrivals/a/image',
        headers: { Authorization: 'Bearer token-new' },
      },
    });

    cleanup?.();
    expect(listener).toBeUndefined();
  });

  it('gives Android a local file without bearer headers and discards a late result after logout', async () => {
    process.env.EXPO_OS = 'android';
    let listener: ((token: string | null) => void) | undefined;
    let complete!: (uri: string) => void;
    const setState = jest.fn();
    jest.doMock('react', () => ({
      useState: () => [undefined, setState],
      useEffect: (effect: () => void) => effect(),
    }));
    jest.doMock('../services/authStorage', () => ({
      getToken: jest.fn().mockResolvedValue('access-token'),
      onAccessTokenChanged: jest.fn((callback) => {
        listener = callback;
        return jest.fn();
      }),
    }));
    const loadPhoto = jest.fn().mockResolvedValueOnce('file:///photos/remote-a.jpg')
      .mockImplementationOnce(() => new Promise<string>((resolve) => { complete = resolve; }));
    jest.doMock('../services/remoteArticlePhoto', () => ({ loadRemoteArticlePhoto: loadPhoto }));
    const { useAuthenticatedImageSource } = await import('../hooks/useAuthenticatedImageSource');
    useAuthenticatedImageSource('https://api.example.test/v1/arrivals/a/image');
    await new Promise((resolve) => setImmediate(resolve));
    expect(setState).toHaveBeenLastCalledWith({
      requestedUri: 'https://api.example.test/v1/arrivals/a/image',
      source: { uri: 'file:///photos/remote-a.jpg' },
    });
    listener?.('rotated-token');
    await new Promise((resolve) => setImmediate(resolve));
    listener?.(null);
    complete('file:///photos/late-private-photo.jpg');
    await new Promise((resolve) => setImmediate(resolve));
    expect(setState).toHaveBeenLastCalledWith(undefined);
  });

  it('does not resurrect a credential from an older asynchronous read after logout', async () => {
    let listener: ((token: string | null) => void) | undefined;
    let complete!: (token: string) => void;
    const setState = jest.fn();
    jest.doMock('react', () => ({
      useState: () => [undefined, setState],
      useEffect: (effect: () => void) => effect(),
    }));
    jest.doMock('../services/authStorage', () => ({
      getToken: jest.fn(() => new Promise<string>((resolve) => { complete = resolve; })),
      onAccessTokenChanged: jest.fn((callback) => { listener = callback; return jest.fn(); }),
    }));
    const { useAuthenticatedImageSource } = await import('../hooks/useAuthenticatedImageSource');
    useAuthenticatedImageSource('https://api.example.test/v1/arrivals/a/image');
    listener?.(null);
    complete('stale-token');
    await new Promise((resolve) => setImmediate(resolve));
    expect(setState).toHaveBeenLastCalledWith(undefined);
  });

  it('exposes download and decoder failures and retries after clearing the failed cache', async () => {
    process.env.EXPO_OS = 'android';
    const slots: unknown[] = [];
    let cursor = 0;
    let previousDependencies: unknown[] = [];
    let cleanup: (() => void) | undefined;
    jest.doMock('react', () => ({
      useState: (initial: unknown) => {
        const slot = cursor++;
        if (!(slot in slots)) slots[slot] = initial;
        return [slots[slot], (next: unknown) => {
          slots[slot] = typeof next === 'function' ? next(slots[slot]) : next;
        }];
      },
      useEffect: (effect: () => (() => void), dependencies: unknown[]) => {
        if (dependencies.some((value, index) => value !== previousDependencies[index])) {
          cleanup?.();
          cleanup = effect();
          previousDependencies = dependencies;
        }
      },
    }));
    jest.doMock('../services/authStorage', () => ({
      getToken: jest.fn().mockResolvedValue('access-token'),
      onAccessTokenChanged: jest.fn(() => jest.fn()),
    }));
    const loadPhoto = jest.fn().mockRejectedValueOnce(new Error('Network failed'))
      .mockResolvedValue('file:///photos/retried.jpg');
    const invalidate = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../services/remoteArticlePhoto', () => ({
      loadRemoteArticlePhoto: loadPhoto,
      invalidateRemoteArticlePhoto: invalidate,
    }));
    const { useAuthenticatedImage } = await import('../hooks/useAuthenticatedImageSource');
    const render = () => {
      cursor = 0;
      return useAuthenticatedImage('https://api.example.test/v1/arrivals/a/image');
    };
    render();
    await new Promise((resolve) => setImmediate(resolve));
    expect(render().failed).toBe(true);
    render().retry();
    await new Promise((resolve) => setImmediate(resolve));
    render();
    await new Promise((resolve) => setImmediate(resolve));
    const loaded = render();
    expect(invalidate).toHaveBeenCalledWith('https://api.example.test/v1/arrivals/a/image');
    expect(loaded.source).toEqual({ uri: 'file:///photos/retried.jpg' });
    expect(loaded.failed).toBe(false);
    loaded.onError?.();
    expect(render().failed).toBe(true);
    expect(render().source).toBeUndefined();
    cleanup?.();
  });
});
