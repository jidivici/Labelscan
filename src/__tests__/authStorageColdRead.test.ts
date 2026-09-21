describe('cold SecureStore read isolation', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it.each([
    ['labelscan.access_token', 'getToken'],
    ['labelscan.refresh_token', 'getRefreshToken'],
    ['labelscan.operator_context', 'getOperatorContext'],
  ] as const)(
    'does not republish a delayed %s read after session purge',
    async (key, getterName) => {
      const SecureStore = await import('expo-secure-store');
      let releaseRead!: (value: string | null) => void;
      let reportStarted!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        reportStarted = resolve;
      });
      const delayedRead = new Promise<string | null>((resolve) => {
        releaseRead = resolve;
      });
      jest.mocked(SecureStore.getItemAsync).mockImplementation((requestedKey) => {
        if (requestedKey === key) {
          reportStarted();
          return delayedRead;
        }
        return Promise.resolve(null);
      });
      const authStorage = await import('../services/authStorage');

      const read = authStorage[getterName]();
      await readStarted;
      const clearing = authStorage.clearSessionTokens();
      releaseRead(
        key === 'labelscan.operator_context'
          ? JSON.stringify({
              organizationId: 'old-org',
              actorId: 'old-actor',
              businessPortalId: 'old-portal',
              tradeCode: 'poissonnerie',
            })
          : 'old-secret',
      );

      await clearing;
      await expect(read).resolves.toBeNull();
      await expect(authStorage[getterName]()).resolves.toBeNull();
    },
  );
});
