import * as SecureStore from 'expo-secure-store';

import {
  clearSessionTokens,
  getOperatorContext,
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
      businessPortalId: 'portal-42',
      tradeCode: 'boucherie',
    });

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'labelscan.operator_context',
      JSON.stringify({ businessPortalId: 'portal-42', tradeCode: 'boucherie' }),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
    await expect(getOperatorContext()).resolves.toEqual({
      businessPortalId: 'portal-42',
      tradeCode: 'boucherie',
    });
  });
});
