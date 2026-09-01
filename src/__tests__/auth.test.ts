jest.mock('../services/api', () => ({
  apiRequest: jest.fn(),
}));

jest.mock('../services/authStorage', () => ({
  clearSessionCredentials: jest.fn(),
  getRefreshToken: jest.fn(),
  setOperatorContext: jest.fn(),
  setTokens: jest.fn(),
  setUsername: jest.fn(),
}));

import { apiRequest } from '../services/api';
import { login, restoreAuthentication } from '../services/auth';
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
    jest.clearAllMocks();
    clearSessionCredentialsMock.mockResolvedValue(undefined);
    getRefreshTokenMock.mockResolvedValue('stored-refresh');
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
});
