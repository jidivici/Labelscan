import * as SecureStore from 'expo-secure-store';

import {
  captureActiveSession,
  clearSessionCredentials,
  clearSessionTokens,
  getRefreshToken,
  getOperatorContext,
  getToken,
  isSessionFenceCurrent,
  onAccessTokenChanged,
  setOperatorContext,
  setTokens,
} from '../services/authStorage';

describe('secure session token storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores access and refresh tokens with device-only unlocked accessibility', async () => {
    await setTokens('access-value', 'refresh-value');

    expect(SecureStore.setItemAsync).toHaveBeenNthCalledWith(
      1,
      'labelscan.access_token',
      'access-value',
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
    expect(SecureStore.setItemAsync).toHaveBeenNthCalledWith(
      2,
      'labelscan.refresh_token',
      'refresh-value',
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
  });

  it('clears both credentials even when secure storage deletion is best-effort', async () => {
    await clearSessionTokens();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('labelscan.access_token');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('labelscan.refresh_token');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('labelscan.operator_context');
  });

  it('persists and restores the server-assigned operator context in SecureStore', async () => {
    await setOperatorContext({
      organizationId: 'org-42',
      actorId: 'actor-42',
      businessPortalId: 'portal-42',
      tradeCode: 'boucherie',
    });

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'labelscan.operator_context',
      JSON.stringify({
        organizationId: 'org-42',
        actorId: 'actor-42',
        businessPortalId: 'portal-42',
        tradeCode: 'boucherie',
      }),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
    await expect(getOperatorContext()).resolves.toEqual({
      organizationId: 'org-42',
      actorId: 'actor-42',
      businessPortalId: 'portal-42',
      tradeCode: 'boucherie',
    });
  });

  it('aborts the previous generation on scope change and logout', async () => {
    await setOperatorContext({
      organizationId: 'org-a',
      actorId: 'actor-a',
      businessPortalId: 'portal-a',
      tradeCode: 'poissonnerie',
    });
    const first = await captureActiveSession();
    expect(isSessionFenceCurrent(first)).toBe(true);

    await setOperatorContext({
      organizationId: 'org-b',
      actorId: 'actor-b',
      businessPortalId: 'portal-b',
      tradeCode: 'boucherie',
    });
    expect(first?.signal.aborted).toBe(true);
    expect(isSessionFenceCurrent(first)).toBe(false);
    expect(isSessionFenceCurrent(await captureActiveSession())).toBe(true);

    await clearSessionTokens();
    expect(await captureActiveSession()).toBeNull();
  });

  it('does not republish a context whose keychain write finishes after logout starts', async () => {
    let releaseWrite!: () => void;
    let reportStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    (SecureStore.setItemAsync as jest.Mock).mockImplementation((key: string) => {
      if (key === 'labelscan.operator_context') {
        reportStarted();
        return writeGate;
      }
      return Promise.resolve();
    });

    const staleWrite = setOperatorContext({
      organizationId: 'org-stale',
      actorId: 'actor-stale',
      businessPortalId: 'portal-stale',
      tradeCode: 'poissonnerie',
    });
    await writeStarted;
    const clearing = clearSessionTokens();
    releaseWrite();

    await expect(staleWrite).rejects.toThrow('MOBILE_SESSION_CHANGED');
    await clearing;
    await expect(getOperatorContext()).resolves.toBeNull();
  });

  it('keeps memory credentials cleared after an older delayed set finishes', async () => {
    let releaseWrite!: () => void;
    let reportStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    (SecureStore.setItemAsync as jest.Mock).mockImplementation((key: string) => {
      if (key === 'labelscan.access_token') {
        reportStarted();
        return writeGate;
      }
      return Promise.resolve();
    });

    const delayedSet = setTokens('stale-access', 'stale-refresh');
    await writeStarted;
    const clearing = clearSessionTokens();
    releaseWrite();

    await expect(delayedSet).rejects.toThrow('MOBILE_SESSION_CHANGED');
    await clearing;
    await expect(getToken()).resolves.toBeNull();
    await expect(getRefreshToken()).resolves.toBeNull();
  });

  it('waits for every credential deletion and reports any native purge failure', async () => {
    (SecureStore.deleteItemAsync as jest.Mock).mockImplementation((key: string) =>
      key === 'labelscan.refresh_token'
        ? Promise.reject(new Error('keystore unavailable'))
        : Promise.resolve(),
    );

    await expect(clearSessionCredentials()).rejects.toThrow('SECURE_SESSION_PURGE_FAILED');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('labelscan.access_token');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('labelscan.refresh_token');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('labelscan.operator_context');
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('labelscan.username');
  });

  it('drops in-memory Bearer listeners before a slow native deletion completes', async () => {
    let releaseDelete!: () => void;
    const deletionGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    (SecureStore.deleteItemAsync as jest.Mock).mockImplementation((key: string) =>
      key === 'labelscan.access_token' ? deletionGate : Promise.resolve(),
    );
    const listener = jest.fn();
    const unsubscribe = onAccessTokenChanged(listener);

    const clearing = clearSessionTokens();
    expect(listener).toHaveBeenCalledWith(null);
    releaseDelete();
    await clearing;
    unsubscribe();
  });
});
