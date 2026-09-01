describe('authenticated image source', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  afterEach(() => {
    jest.dontMock('react');
    jest.dontMock('../services/authStorage');
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
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
      uri: 'https://api.example.test/v1/arrivals/a/image',
      headers: { Authorization: 'Bearer token-old' },
    });

    listener?.('token-new');
    expect(setState).toHaveBeenLastCalledWith({
      uri: 'https://api.example.test/v1/arrivals/a/image',
      headers: { Authorization: 'Bearer token-new' },
    });

    cleanup?.();
    expect(listener).toBeUndefined();
  });
});
