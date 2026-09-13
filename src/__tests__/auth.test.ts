jest.mock('../services/api', () => ({
  ApiError: jest.requireActual<typeof import('../services/api')>('../services/api').ApiError,
  apiRequest: jest.fn(),
}));

jest.mock('../services/authStorage', () => ({
  clearSessionCredentials: jest.fn(),
  getRefreshToken: jest.fn(),
  setOperatorContext: jest.fn(),
  setTokens: jest.fn(),
  setUsername: jest.fn(),
}));

import { ApiError, apiRequest } from '../services/api';
import { isAuthenticationRestoreRetryable, login, restoreAuthentication } from '../services/auth';
import {
  clearSessionCredentials,
  getRefreshToken,
  setOperatorContext,
  setTokens,
  setUsername,
} from '../services/authStorage';

const requestMock = jest.mocked(apiRequest);
const setTokensMock = jest.mocked(setTokens);
const setUsernameMock = jest.mocked(setUsername);
const clearSessionCredentialsMock = jest.mocked(clearSessionCredentials);
const getRefreshTokenMock = jest.mocked(getRefreshToken);
const setOperatorContextMock = jest.mocked(setOperatorContext);

function managerResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'manager-token',
    refresh_token: 'manager-refresh',
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
    ...overrides,
  };
}

describe('mobile manager authentication', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    clearSessionCredentialsMock.mockResolvedValue(undefined);
    getRefreshTokenMock.mockResolvedValue('stored-refresh');
    setTokensMock.mockResolvedValue(undefined);
    setUsernameMock.mockResolvedValue(undefined);
    setOperatorContextMock.mockResolvedValue(undefined);
  });

  it('uses the manager-only mobile endpoint and persists the session', async () => {
    requestMock.mockResolvedValue(managerResponse());

    await expect(login('manager', 'secret')).resolves.toEqual({
      username: 'manager',
      organizationId: 'org-labelscan',
      actorId: 'actor-manager',
      businessPortalId: 'portal-poissonnerie',
      tradeCode: 'poissonnerie',
    });

    expect(requestMock).toHaveBeenCalledWith('/v1/mobile/auth/login', {
      method: 'POST',
      body: { username: 'manager', password: 'secret' },
      skipAuth: true,
    });
    expect(setTokensMock).toHaveBeenCalledWith('manager-token', 'manager-refresh');
    expect(setUsernameMock).toHaveBeenCalledWith('manager');
    expect(setOperatorContextMock).toHaveBeenCalledWith({
      organizationId: 'org-labelscan',
      actorId: 'actor-manager',
      businessPortalId: 'portal-poissonnerie',
      tradeCode: 'poissonnerie',
    });
  });

  it('never stores an administrator session in the mobile app', async () => {
    requestMock.mockResolvedValue({
      access_token: 'admin-token',
      refresh_token: 'admin-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_expires_in: 604800,
      user: {
        id: 'actor-admin',
        role: 'admin',
        username: 'admin',
        organization_id: 'org-labelscan',
        business_portal_id: null,
        trade_code: null,
      },
    });

    await expect(login('admin', 'secret')).rejects.toThrow(
      'MOBILE_ACCESS_DENIED',
    );
    expect(setTokensMock).not.toHaveBeenCalled();
    expect(setUsernameMock).not.toHaveBeenCalled();
  });

  it('rejects a manager session without a server-assigned supported portal context', async () => {
    requestMock.mockResolvedValue(
      managerResponse({
        user: {
          id: 'actor-manager',
          role: 'manager',
          username: 'manager',
          organization_id: 'org-labelscan',
          business_portal_id: null,
          trade_code: null,
        },
      }),
    );

    await expect(login('operator', 'secret')).rejects.toThrow('MOBILE_CONTEXT_MISSING');
    expect(setTokensMock).not.toHaveBeenCalled();
    expect(setOperatorContextMock).not.toHaveBeenCalled();
  });

  it('rolls back every credential when SecureStore persists only part of a session', async () => {
    requestMock.mockResolvedValue(managerResponse());
    setOperatorContextMock.mockRejectedValueOnce(new Error('keystore failure'));

    await expect(login('manager', 'secret')).rejects.toThrow('keystore failure');
    expect(clearSessionCredentialsMock).toHaveBeenCalled();
  });

  it('restores a cold-start session by rotating the persisted refresh token', async () => {
    requestMock.mockResolvedValue({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      token_type: 'bearer',
      expires_in: 900,
      refresh_expires_in: 604800,
      user: {
        id: 'actor-manager',
        role: 'manager',
        username: 'manager',
        organization_id: 'org-labelscan',
        business_portal_id: 'portal-charcuterie',
        trade_code: 'charcuterie_traiteur',
      },
    });

    await expect(restoreAuthentication()).resolves.toEqual({
      username: 'manager',
      organizationId: 'org-labelscan',
      actorId: 'actor-manager',
      businessPortalId: 'portal-charcuterie',
      tradeCode: 'charcuterie_traiteur',
    });
    expect(requestMock).toHaveBeenCalledWith('/v1/mobile/auth/refresh', {
      method: 'POST',
      body: { refresh_token: 'stored-refresh' },
      skipAuth: true,
    });
    expect(setTokensMock).toHaveBeenCalledWith('access-new', 'refresh-new');
    expect(setOperatorContextMock).toHaveBeenCalledWith({
      organizationId: 'org-labelscan',
      actorId: 'actor-manager',
      businessPortalId: 'portal-charcuterie',
      tradeCode: 'charcuterie_traiteur',
    });
  });

  it('clears persisted credentials when cold-start refresh fails', async () => {
    requestMock.mockRejectedValue(new Error('expired'));

    await expect(restoreAuthentication()).resolves.toBeNull();
    expect(clearSessionCredentialsMock).toHaveBeenCalled();
  });

  it.each([
    ['NETWORK_ERROR', 0],
    ['TIMEOUT', 0],
    ['HTTP_408', 408],
    ['HTTP_429', 429],
    ['HTTP_500', 500],
    ['HTTP_502', 502],
    ['HTTP_503', 503],
    ['HTTP_504', 504],
  ])('preserves the persisted session and exposes a retryable %s failure', async (code, status) => {
    const error = new ApiError({
      code: code as string,
      status: status as number,
      message: 'temporary failure',
      // The transport/status classification remains authoritative even if a
      // server does not advertise that a temporary service error is retryable.
      retriable: false,
    });
    requestMock.mockRejectedValue(error);

    await expect(restoreAuthentication()).rejects.toBe(error);

    expect(isAuthenticationRestoreRetryable(error)).toBe(true);
    expect(clearSessionCredentialsMock).not.toHaveBeenCalled();
    expect(setTokensMock).not.toHaveBeenCalled();
    expect(setUsernameMock).not.toHaveBeenCalled();
    expect(setOperatorContextMock).not.toHaveBeenCalled();
  });

  it.each([401, 403])('rejects HTTP %i permanently even if advertised as retryable', async (status) => {
    const error = new ApiError({
      code: status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN',
      status,
      message: 'session no longer authorized',
      retriable: true,
    });
    requestMock.mockRejectedValue(error);

    await expect(restoreAuthentication()).resolves.toBeNull();

    expect(isAuthenticationRestoreRetryable(error)).toBe(false);
    expect(clearSessionCredentialsMock).toHaveBeenCalled();
    expect(setTokensMock).not.toHaveBeenCalled();
    expect(setUsernameMock).not.toHaveBeenCalled();
    expect(setOperatorContextMock).not.toHaveBeenCalled();
  });

  it.each([
    ['CONFIG_ERROR', 0],
    ['INVALID_RESPONSE', 200],
    ['SESSION_CHANGED', 0],
    ['HTTP_400', 400],
  ])('does not mistake %s for a temporary network failure', async (code, status) => {
    const error = new ApiError({
      code: code as string,
      status: status as number,
      message: 'permanent failure',
      retriable: true,
    });
    requestMock.mockRejectedValue(error);

    await expect(restoreAuthentication()).resolves.toBeNull();

    expect(isAuthenticationRestoreRetryable(error)).toBe(false);
    expect(clearSessionCredentialsMock).toHaveBeenCalled();
    expect(setTokensMock).not.toHaveBeenCalled();
  });

  it('stops an already canceled restoration before reading credentials or sending a request', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(restoreAuthentication({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(getRefreshTokenMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
    expect(clearSessionCredentialsMock).not.toHaveBeenCalled();
    expect(setTokensMock).not.toHaveBeenCalled();
  });

  it('stops cancellation during credential loading before a request or any cleanup', async () => {
    const controller = new AbortController();
    getRefreshTokenMock.mockImplementationOnce(async () => {
      controller.abort();
      return 'stored-refresh';
    });

    await expect(restoreAuthentication({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(requestMock).not.toHaveBeenCalled();
    expect(clearSessionCredentialsMock).not.toHaveBeenCalled();
    expect(setTokensMock).not.toHaveBeenCalled();
  });

  it('ignores a successful response received after cancellation without storing or purging a session', async () => {
    const controller = new AbortController();
    requestMock.mockImplementationOnce(async () => {
      controller.abort();
      return managerResponse();
    });

    await expect(restoreAuthentication({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(requestMock).toHaveBeenCalledWith('/v1/mobile/auth/refresh', {
      method: 'POST',
      body: { refresh_token: 'stored-refresh' },
      skipAuth: true,
      signal: controller.signal,
    });
    expect(clearSessionCredentialsMock).not.toHaveBeenCalled();
    expect(setTokensMock).not.toHaveBeenCalled();
    expect(setUsernameMock).not.toHaveBeenCalled();
    expect(setOperatorContextMock).not.toHaveBeenCalled();
  });

  it('treats a canceled transport timeout as cancellation without purging credentials', async () => {
    const controller = new AbortController();
    requestMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new ApiError({ code: 'TIMEOUT', status: 0, message: 'aborted', retriable: true });
    });

    await expect(restoreAuthentication({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(clearSessionCredentialsMock).not.toHaveBeenCalled();
    expect(setTokensMock).not.toHaveBeenCalled();
    expect(setUsernameMock).not.toHaveBeenCalled();
    expect(setOperatorContextMock).not.toHaveBeenCalled();
  });

  it.each([
    { access_token: undefined },
    { refresh_token: undefined },
    { user: undefined },
    { user: { ...managerResponse().user, business_portal_id: null } },
    { user: { ...managerResponse().user, role: 'admin' } },
  ])('purges an incomplete or unauthorized cold-start response: %j', async (overrides) => {
    requestMock.mockResolvedValue(managerResponse(overrides));

    await expect(restoreAuthentication()).resolves.toBeNull();

    expect(clearSessionCredentialsMock).toHaveBeenCalled();
    expect(setTokensMock).not.toHaveBeenCalled();
    expect(setUsernameMock).not.toHaveBeenCalled();
    expect(setOperatorContextMock).not.toHaveBeenCalled();
  });

  it('clears orphaned credentials without a request when no refresh token exists', async () => {
    getRefreshTokenMock.mockResolvedValue(null);

    await expect(restoreAuthentication()).resolves.toBeNull();

    expect(requestMock).not.toHaveBeenCalled();
    expect(clearSessionCredentialsMock).toHaveBeenCalled();
    expect(setTokensMock).not.toHaveBeenCalled();
  });

  it('fails closed and rolls back credentials when cold-start persistence partially fails', async () => {
    requestMock.mockResolvedValue(managerResponse());
    setOperatorContextMock.mockRejectedValueOnce(new Error('keystore failure'));

    await expect(restoreAuthentication()).resolves.toBeNull();

    expect(clearSessionCredentialsMock).toHaveBeenCalled();
  });

  it('propagates a failed credential purge instead of reporting a restored session', async () => {
    const purgeError = new Error('SECURE_SESSION_PURGE_FAILED');
    requestMock.mockRejectedValue(new ApiError({
      code: 'UNAUTHENTICATED',
      status: 401,
      message: 'expired',
    }));
    clearSessionCredentialsMock.mockRejectedValue(purgeError);

    await expect(restoreAuthentication()).rejects.toBe(purgeError);

    expect(setTokensMock).not.toHaveBeenCalled();
    expect(setUsernameMock).not.toHaveBeenCalled();
    expect(setOperatorContextMock).not.toHaveBeenCalled();
  });

  it('does not purge a newer session when canceled during a failed credential write', async () => {
    const controller = new AbortController();
    requestMock.mockResolvedValue(managerResponse());
    setOperatorContextMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('MOBILE_SESSION_CHANGED');
    });

    await expect(restoreAuthentication({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(clearSessionCredentialsMock).not.toHaveBeenCalled();
  });
});
