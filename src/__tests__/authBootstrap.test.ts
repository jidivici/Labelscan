import * as React from 'react';
import * as SecureStore from 'expo-secure-store';

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useState: (initial: unknown) => mockHarness.useState(initial),
  useRef: (initial: unknown) => mockHarness.useRef(initial),
  useEffect: (effect: () => void | (() => void), dependencies?: unknown[]) =>
    mockHarness.useEffect(effect, dependencies),
  useCallback: (callback: unknown, dependencies?: unknown[]) =>
    mockHarness.useMemo(() => callback, dependencies),
  useContext: () => mockAuthValue,
}));

jest.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  ActivityIndicator: 'ActivityIndicator',
  StatusBar: 'StatusBar',
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles },
}));
jest.mock('@react-navigation/native', () => ({ NavigationContainer: 'NavigationContainer' }));
jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen' }),
}));
jest.mock('../screens/CameraScreen', () => ({ CameraScreen: 'CameraScreen' }));
jest.mock('../screens/ReviewScreen', () => ({ ReviewScreen: 'ReviewScreen' }));
jest.mock('../screens/ArticleListScreen', () => ({ ArticleListScreen: 'ArticleListScreen' }));
jest.mock('../screens/LoginScreen', () => ({ LoginScreen: 'LoginScreen' }));
jest.mock('../services/api', () => ({
  ...jest.requireActual('../services/api'),
  apiRequest: jest.fn(),
}));
jest.mock('../services/queryClient', () => ({ queryClient: { clear: jest.fn() } }));
jest.mock('../services/sessionData', () => ({
  clearLocalSessionData: jest.fn().mockResolvedValue(undefined),
  purgeLegacyLocalData: jest.fn().mockResolvedValue(undefined),
}));

import { AuthProvider, useAuth } from '../context/AuthContext';
import { RootNavigator } from '../navigation/RootNavigator';
import { ApiError, apiRequest } from '../services/api';
import {
  clearSessionCredentials,
  emitUnauthenticated,
  getRefreshToken,
  getToken,
  setTokens,
} from '../services/authStorage';
import { clearLocalSessionData, purgeLegacyLocalData } from '../services/sessionData';

type TestElement = React.ReactElement<Record<string, any>>;
type EffectSlot = { dependencies?: unknown[]; cleanup?: () => void };
type AuthValue = ReturnType<typeof useAuth>;

let mockHarness: AuthBootstrapHarness;
let mockAuthValue: AuthValue;
const requestMock = jest.mocked(apiRequest);

function dependenciesMatch(previous: unknown[] | undefined, next: unknown[] | undefined) {
  return previous !== undefined && next !== undefined
    && previous.length === next.length
    && previous.every((item, index) => Object.is(item, next[index]));
}

/**
 * Like cameraScreen.test.ts, this Node host retains real hook state and effects
 * without a native renderer. It passes the actual provider value to the actual
 * root auth gate; authentication, retry scheduling and secure storage stay real.
 */
class AuthBootstrapHarness {
  private slots: any[] = [];
  private cursor = 0;
  private dirty = false;
  private effects: (() => void)[] = [];
  private effectSlots = new Set<EffectSlot>();
  tree!: TestElement;

  get auth() { return mockAuthValue; }

  useState(initial: unknown) {
    const index = this.cursor++;
    if (!(index in this.slots)) {
      this.slots[index] = typeof initial === 'function' ? initial() : initial;
    }
    return [this.slots[index], (value: any) => {
      const next = typeof value === 'function' ? value(this.slots[index]) : value;
      if (!Object.is(this.slots[index], next)) {
        this.slots[index] = next;
        this.dirty = true;
      }
    }];
  }

  useRef(initial: unknown) {
    const index = this.cursor++;
    if (!(index in this.slots)) this.slots[index] = { current: initial };
    return this.slots[index];
  }

  useMemo(factory: () => unknown, dependencies?: unknown[]) {
    const index = this.cursor++;
    const previous = this.slots[index];
    if (!previous || !dependenciesMatch(previous.dependencies, dependencies)) {
      this.slots[index] = { value: factory(), dependencies };
    }
    return this.slots[index].value;
  }

  useEffect(effect: () => void | (() => void), dependencies?: unknown[]) {
    const index = this.cursor++;
    const previous: EffectSlot | undefined = this.slots[index];
    if (previous && dependenciesMatch(previous.dependencies, dependencies)) return;
    const slot: EffectSlot = { dependencies };
    this.slots[index] = slot;
    this.effects.push(() => {
      previous?.cleanup?.();
      if (previous) this.effectSlots.delete(previous);
      slot.cleanup = effect() || undefined;
      this.effectSlots.add(slot);
    });
  }

  render() {
    let renderCount = 0;
    do {
      if (++renderCount > 20) throw new Error('Auth bootstrap did not settle after effects');
      this.cursor = 0;
      this.dirty = false;
      const provider = AuthProvider({ children: null });
      mockAuthValue = provider.props.value;
      this.tree = RootNavigator();
      this.effects.splice(0).forEach((effect) => effect());
    } while (this.dirty);
    return this;
  }

  find(type: string, node: React.ReactNode = this.tree): TestElement | undefined {
    if (!React.isValidElement(node)) return undefined;
    const element = node as TestElement;
    if ((element.type as unknown) === type) return element;
    for (const child of React.Children.toArray(element.props.children)) {
      const found = this.find(type, child);
      if (found) return found;
    }
    return undefined;
  }

  unmount() {
    for (const slot of this.effectSlots) slot.cleanup?.();
    this.effectSlots.clear();
  }
}

function managerResponse() {
  return {
    access_token: 'access-renewed',
    refresh_token: 'refresh-renewed',
    token_type: 'bearer',
    expires_in: 3600,
    refresh_expires_in: 604800,
    user: {
      id: 'actor-manager',
      role: 'manager',
      username: 'manager',
      organization_id: 'org-labelscan',
      business_portal_id: 'portal-poissonnerie',
      trade_code: 'poissonnerie',
    },
  };
}

function offlineError() {
  return new ApiError({ code: 'NETWORK_ERROR', status: 0, message: 'Wi-Fi unavailable' });
}

function deferredResponse() {
  let resolve!: (value: ReturnType<typeof managerResponse>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReturnType<typeof managerResponse>>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await jest.advanceTimersByTimeAsync(0);
  mockHarness.render();
}

function expectClosedGate(status: 'loading' | 'waitingForConnection') {
  expect(mockHarness.auth).toEqual(expect.objectContaining({
    status,
    user: null,
    actorId: null,
    organizationId: null,
    businessPortalId: null,
    tradeCode: null,
  }));
  expect(mockHarness.find('ActivityIndicator')).toBeDefined();
  expect(mockHarness.find('LoginScreen')).toBeUndefined();
  expect(mockHarness.find('NavigationContainer')).toBeUndefined();
}

describe('cold-start authentication through the provider and root navigation gate', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await clearSessionCredentials();
    await setTokens('access-stored', 'refresh-stored');
    jest.clearAllMocks();
    requestMock.mockReset();
    mockHarness = new AuthBootstrapHarness();
  });

  afterEach(async () => {
    mockHarness.unmount();
    jest.clearAllTimers();
    jest.useRealTimers();
    await clearSessionCredentials();
  });

  it('keeps the saved session and all business UI closed offline, then resumes without login', async () => {
    const retry = deferredResponse();
    requestMock.mockRejectedValueOnce(offlineError()).mockReturnValueOnce(retry.promise);

    mockHarness.render();
    expectClosedGate('loading');
    await settle();
    expectClosedGate('waitingForConnection');
    expect(mockHarness.find('Text')).toBeDefined();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(clearLocalSessionData).not.toHaveBeenCalled();
    expect(purgeLegacyLocalData).not.toHaveBeenCalled();
    await expect(getRefreshToken()).resolves.toBe('refresh-stored');

    await jest.advanceTimersByTimeAsync(2_000);
    mockHarness.render();
    expectClosedGate('waitingForConnection');
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenLastCalledWith('/v1/mobile/auth/refresh', expect.objectContaining({
      body: { refresh_token: 'refresh-stored' },
      signal: expect.any(AbortSignal),
    }));

    retry.resolve(managerResponse());
    await settle();
    expect(mockHarness.auth).toEqual(expect.objectContaining({
      status: 'signedIn',
      user: 'manager',
      organizationId: 'org-labelscan',
      actorId: 'actor-manager',
      businessPortalId: 'portal-poissonnerie',
      tradeCode: 'poissonnerie',
    }));
    expect(mockHarness.find('NavigationContainer')).toBeDefined();
    expect(mockHarness.find('LoginScreen')).toBeUndefined();
    expect(purgeLegacyLocalData).toHaveBeenCalledWith({
      failClosed: true,
      ownerScopeKey: 'org-labelscan:actor-manager:portal-poissonnerie:poissonnerie',
    });
    await expect(getRefreshToken()).resolves.toBe('refresh-renewed');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('shows login and clears credentials when the server rejects the saved session after reconnecting', async () => {
    requestMock.mockRejectedValueOnce(offlineError()).mockRejectedValueOnce(new ApiError({
      code: 'UNAUTHENTICATED', status: 401, message: 'Session revoked',
    }));
    mockHarness.render();
    await settle();
    expectClosedGate('waitingForConnection');

    await jest.advanceTimersByTimeAsync(2_000);
    mockHarness.render();
    expect(mockHarness.auth.status).toBe('signedOut');
    expect(mockHarness.auth.user).toBeNull();
    expect(mockHarness.find('LoginScreen')).toBeDefined();
    expect(mockHarness.find('NavigationContainer')).toBeUndefined();
    await expect(getRefreshToken()).resolves.toBeNull();
    expect(clearLocalSessionData).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('aborts restoration on sign-out and ignores a successful response that arrives afterwards', async () => {
    const pending = deferredResponse();
    requestMock.mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    mockHarness.render();
    await settle();
    const signal = requestMock.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);

    await mockHarness.auth.signOut();
    mockHarness.render();
    expect(signal?.aborted).toBe(true);
    expect(mockHarness.auth.status).toBe('signedOut');
    expect(mockHarness.find('LoginScreen')).toBeDefined();
    const writesAfterSignOut = jest.mocked(SecureStore.setItemAsync).mock.calls.length;

    pending.resolve(managerResponse());
    await settle();
    expect(mockHarness.auth.status).toBe('signedOut');
    expect(mockHarness.auth.user).toBeNull();
    expect(mockHarness.find('NavigationContainer')).toBeUndefined();
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(writesAfterSignOut);
    await expect(getToken()).resolves.toBeNull();
    await expect(getRefreshToken()).resolves.toBeNull();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      '/v1/mobile/auth/refresh', '/v1/mobile/auth/logout',
    ]);
  });

  it('cancels a pending retry when an unauthenticated event closes the session', async () => {
    requestMock.mockRejectedValue(offlineError());
    mockHarness.render();
    await settle();
    expectClosedGate('waitingForConnection');

    emitUnauthenticated();
    await settle();
    expect(mockHarness.auth.status).toBe('signedOut');
    expect(mockHarness.find('LoginScreen')).toBeDefined();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'rejection'] as const)(
    'keeps a new explicit login when the canceled bootstrap returns a late %s',
    async (outcome) => {
      const pending = deferredResponse();
      const fresh = managerResponse();
      fresh.user.username = 'new-manager';
      fresh.access_token = 'access-explicit-login';
      fresh.refresh_token = 'refresh-explicit-login';
      requestMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(fresh);
      mockHarness.render();
      await settle();
      const signal = requestMock.mock.calls[0][1]?.signal;

      await mockHarness.auth.signIn('new-manager', 'secret');
      mockHarness.render();
      expect(signal?.aborted).toBe(true);
      expect(mockHarness.auth.status).toBe('signedIn');
      expect(mockHarness.auth.user).toBe('new-manager');
      const deletesAfterSignIn = jest.mocked(SecureStore.deleteItemAsync).mock.calls.length;

      if (outcome === 'success') pending.resolve(managerResponse());
      else pending.reject(new ApiError({
        code: 'UNAUTHENTICATED', status: 401, message: 'Old session revoked',
      }));
      await settle();

      expect(mockHarness.auth.status).toBe('signedIn');
      expect(mockHarness.auth.user).toBe('new-manager');
      expect(mockHarness.find('NavigationContainer')).toBeDefined();
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(deletesAfterSignIn);
      await expect(getToken()).resolves.toBe('access-explicit-login');
      await expect(getRefreshToken()).resolves.toBe('refresh-explicit-login');
      await jest.advanceTimersByTimeAsync(60_000);
      expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
        '/v1/mobile/auth/refresh', '/v1/mobile/auth/login',
      ]);
    },
  );

  it('aborts on unmount without accepting a late response or deleting the saved credential', async () => {
    const pending = deferredResponse();
    requestMock.mockReturnValueOnce(pending.promise);
    mockHarness.render();
    await settle();
    const signal = requestMock.mock.calls[0][1]?.signal;

    mockHarness.unmount();
    expect(signal?.aborted).toBe(true);
    pending.resolve(managerResponse());
    await jest.advanceTimersByTimeAsync(60_000);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(purgeLegacyLocalData).not.toHaveBeenCalled();
    await expect(getRefreshToken()).resolves.toBe('refresh-stored');
  });
});
