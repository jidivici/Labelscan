jest.mock('../services/api', () => ({
  apiRequest: jest.fn(),
}));

jest.mock('../services/authStorage', () => ({
  clearSessionTokens: jest.fn(),
  clearUsername: jest.fn(),
  getRefreshToken: jest.fn(),
  setOperatorContext: jest.fn(),
  setTokens: jest.fn(),
  setUsername: jest.fn(),
}));

import { apiRequest } from '../services/api';
import { activateOperator, login, restoreAuthentication } from '../services/auth';
import {
  clearSessionTokens,
  clearUsername,
  getRefreshToken,
  setOperatorContext,
  setTokens,
  setUsername,
} from '../services/authStorage';

const requestMock = jest.mocked(apiRequest);
const setTokensMock = jest.mocked(setTokens);
const setUsernameMock = jest.mocked(setUsername);
const clearSessionTokensMock = jest.mocked(clearSessionTokens);
const clearUsernameMock = jest.mocked(clearUsername);
const getRefreshTokenMock = jest.mocked(getRefreshToken);
const setOperatorContextMock = jest.mocked(setOperatorContext);

function operatorResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'operator-token',
    refresh_token: 'operator-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    refresh_expires_in: 604800,
    user: {
      role: 'operator',
      username: 'operator',
      business_portal_id: 'portal-poissonnerie',
      trade_code: 'poissonnerie',
    },
    ...overrides,
  };
}

describe('mobile operator authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getRefreshTokenMock.mockResolvedValue('stored-refresh');
  });

  it('uses the operator-only mobile endpoint and persists the session', async () => {
    requestMock.mockResolvedValue(operatorResponse());

    await expect(login('operator', 'secret')).resolves.toEqual({
      username: 'operator',
      businessPortalId: 'portal-poissonnerie',
      tradeCode: 'poissonnerie',
    });

    expect(requestMock).toHaveBeenCalledWith('/v1/mobile/auth/login', {
      method: 'POST',
      body: { username: 'operator', password: 'secret' },
      skipAuth: true,
    });
    expect(setTokensMock).toHaveBeenCalledWith('operator-token', 'operator-refresh');
    expect(setUsernameMock).toHaveBeenCalledWith('operator');
    expect(setOperatorContextMock).toHaveBeenCalledWith({
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
        role: 'admin',
        username: 'admin',
        business_portal_id: null,
        trade_code: null,
      },
    });

    await expect(login('admin', 'secret')).rejects.toThrow(
      'MOBILE_OPERATOR_ONLY',
    );
    expect(setTokensMock).not.toHaveBeenCalled();
    expect(setUsernameMock).not.toHaveBeenCalled();
  });

  it('rejects an operator session without a server-assigned supported portal context', async () => {
    requestMock.mockResolvedValue(
      operatorResponse({
        user: {
          role: 'operator',
          username: 'operator',
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
    requestMock.mockResolvedValue(operatorResponse());
    setOperatorContextMock.mockRejectedValueOnce(new Error('keystore failure'));

    await expect(login('operator', 'secret')).rejects.toThrow('keystore failure');
    expect(clearSessionTokensMock).toHaveBeenCalled();
    expect(clearUsernameMock).toHaveBeenCalled();
  });

  it('activates a one-use token then logs in to receive the authoritative context', async () => {
    requestMock
      .mockResolvedValueOnce({ username: 'new-operator', role: 'operator', active: true })
      .mockResolvedValueOnce(
        operatorResponse({
          user: {
            role: 'operator',
            username: 'new-operator',
            business_portal_id: 'portal-boucherie',
            trade_code: 'boucherie',
          },
        }),
      );

    await expect(
      activateOperator('  one-use-token  ', 'a-secure-password'),
    ).resolves.toEqual({
      username: 'new-operator',
      businessPortalId: 'portal-boucherie',
      tradeCode: 'boucherie',
    });
    expect(requestMock).toHaveBeenNthCalledWith(1, '/v1/mobile/auth/activate', {
      method: 'POST',
      body: { token: 'one-use-token', new_password: 'a-secure-password' },
      skipAuth: true,
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, '/v1/mobile/auth/login', {
      method: 'POST',
      body: { username: 'new-operator', password: 'a-secure-password' },
      skipAuth: true,
    });
  });

  it('restores a cold-start session by rotating the persisted refresh token', async () => {
    requestMock.mockResolvedValue({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      token_type: 'bearer',
      expires_in: 900,
      refresh_expires_in: 604800,
      user: {
        role: 'operator',
        username: 'operator',
        business_portal_id: 'portal-charcuterie',
        trade_code: 'charcuterie_traiteur',
      },
    });

    await expect(restoreAuthentication()).resolves.toEqual({
      username: 'operator',
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
      businessPortalId: 'portal-charcuterie',
      tradeCode: 'charcuterie_traiteur',
    });
  });

  it('clears persisted credentials when cold-start refresh fails', async () => {
    requestMock.mockRejectedValue(new Error('expired'));

    await expect(restoreAuthentication()).resolves.toBeNull();
    expect(clearSessionTokensMock).toHaveBeenCalled();
  });
});
