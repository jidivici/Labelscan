jest.mock('../services/api', () => ({
  apiRequest: jest.fn(),
}));

jest.mock('../services/authStorage', () => ({
  clearToken: jest.fn(),
  clearUsername: jest.fn(),
  setToken: jest.fn(),
  setUsername: jest.fn(),
}));

import { apiRequest } from '../services/api';
import { login } from '../services/auth';
import { setToken, setUsername } from '../services/authStorage';

const requestMock = jest.mocked(apiRequest);
const setTokenMock = jest.mocked(setToken);
const setUsernameMock = jest.mocked(setUsername);

describe('mobile operator authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the operator-only mobile endpoint and persists the session', async () => {
    requestMock.mockResolvedValue({
      access_token: 'operator-token',
      token_type: 'bearer',
      expires_in: 3600,
      user: { role: 'operator' },
    });

    await login('operator', 'secret');

    expect(requestMock).toHaveBeenCalledWith('/v1/mobile/auth/login', {
      method: 'POST',
      body: { username: 'operator', password: 'secret' },
      skipAuth: true,
    });
    expect(setTokenMock).toHaveBeenCalledWith('operator-token');
    expect(setUsernameMock).toHaveBeenCalledWith('operator');
  });

  it('never stores an administrator session in the mobile app', async () => {
    requestMock.mockResolvedValue({
      access_token: 'admin-token',
      token_type: 'bearer',
      expires_in: 3600,
      user: { role: 'admin' },
    });

    await expect(login('admin', 'secret')).rejects.toThrow(
      'MOBILE_OPERATOR_ONLY',
    );
    expect(setTokenMock).not.toHaveBeenCalled();
    expect(setUsernameMock).not.toHaveBeenCalled();
  });
});
