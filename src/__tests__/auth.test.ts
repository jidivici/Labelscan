jest.mock('../services/api', () => ({
  apiRequest: jest.fn(),
}));

jest.mock('../services/authStorage', () => ({
  clearSessionTokens: jest.fn(),
  clearUsername: jest.fn(),
  getRefreshToken: jest.fn(),
  setTokens: jest.fn(),
  setUsername: jest.fn(),
}));

import { apiRequest } from '../services/api';
import { login, restoreAuthentication } from '../services/auth';
import {
  clearSessionTokens,
  getRefreshToken,
  setTokens,
  setUsername,
} from '../services/authStorage';

const requestMock = jest.mocked(apiRequest);
const setTokensMock = jest.mocked(setTokens);
const setUsernameMock = jest.mocked(setUsername);
const clearSessionTokensMock = jest.mocked(clearSessionTokens);
const getRefreshTokenMock = jest.mocked(getRefreshToken);

describe('mobile operator authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getRefreshTokenMock.mockResolvedValue('stored-refresh');
  });

  it('uses the operator-only mobile endpoint and persists the session', async () => {
    requestMock.mockResolvedValue({
      access_token: 'operator-token',
      refresh_token: 'operator-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_expires_in: 604800,
      user: { role: 'operator' },
    });

    await login('operator', 'secret');

    expect(requestMock).toHaveBeenCalledWith('/v1/mobile/auth/login', {
      method: 'POST',
      body: { username: 'operator', password: 'secret' },
      skipAuth: true,
    });
    expect(setTokensMock).toHaveBeenCalledWith('operator-token', 'operator-refresh');
    expect(setUsernameMock).toHaveBeenCalledWith('operator');
  });

  it('never stores an administrator session in the mobile app', async () => {
    requestMock.mockResolvedValue({
      access_token: 'admin-token',
      refresh_token: 'admin-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_expires_in: 604800,
      user: { role: 'admin' },
    });

    await expect(login('admin', 'secret')).rejects.toThrow(
      'MOBILE_OPERATOR_ONLY',
    );
    expect(setTokensMock).not.toHaveBeenCalled();
    expect(setUsernameMock).not.toHaveBeenCalled();
  });

  it('restores a cold-start session by rotating the persisted refresh token', async () => {
    requestMock.mockResolvedValue({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      token_type: 'bearer',
      expires_in: 900,
      refresh_expires_in: 604800,
      user: { role: 'operator' },
    });

    await expect(restoreAuthentication()).resolves.toBe(true);
    expect(requestMock).toHaveBeenCalledWith('/v1/mobile/auth/refresh', {
      method: 'POST',
      body: { refresh_token: 'stored-refresh' },
      skipAuth: true,
    });
    expect(setTokensMock).toHaveBeenCalledWith('access-new', 'refresh-new');
  });

  it('clears persisted credentials when cold-start refresh fails', async () => {
    requestMock.mockRejectedValue(new Error('expired'));

    await expect(restoreAuthentication()).resolves.toBe(false);
    expect(clearSessionTokensMock).toHaveBeenCalled();
  });
});
