import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../services/outbox', () => ({
  clearOutbox: jest.fn(),
  purgeUnsafeOutboxOperations: jest.fn(),
}));
jest.mock('../services/scanQueue', () => ({
  clearScanQueue: jest.fn(),
  purgeUnsafeScanQueueEntries: jest.fn(),
}));
jest.mock('../services/queryClient', () => ({
  queryClient: { clear: jest.fn() },
}));
jest.mock('../services/storage', () => ({
  clearLocalArticlePhotos: jest.fn(),
  retainLocalArticlePhotosForScope: jest.fn(),
}));

import { clearOutbox, purgeUnsafeOutboxOperations } from '../services/outbox';
import { clearScanQueue, purgeUnsafeScanQueueEntries } from '../services/scanQueue';
import {
  clearLocalArticlePhotos,
  retainLocalArticlePhotosForScope,
} from '../services/storage';
import { clearLocalSessionData, purgeLegacyLocalData } from '../services/sessionData';

const mockedClearOutbox = jest.mocked(clearOutbox);
const mockedPurgeOutbox = jest.mocked(purgeUnsafeOutboxOperations);
const mockedClearQueue = jest.mocked(clearScanQueue);
const mockedPurgeQueue = jest.mocked(purgeUnsafeScanQueueEntries);
const mockedClearPhotos = jest.mocked(clearLocalArticlePhotos);
const mockedRetainPhotos = jest.mocked(retainLocalArticlePhotosForScope);

describe('session data transitions', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
    mockedClearOutbox.mockResolvedValue(undefined);
    mockedPurgeOutbox.mockResolvedValue(0);
    mockedClearQueue.mockResolvedValue(undefined);
    mockedPurgeQueue.mockResolvedValue(0);
    mockedClearPhotos.mockResolvedValue(undefined);
    mockedRetainPhotos.mockResolvedValue(undefined);
  });

  it('runs the destructive photo migration once, then preserves confirmed photos', async () => {
    const ownerScopeKey = 'org-a:actor-a:portal-a:poissonnerie';
    await purgeLegacyLocalData({ ownerScopeKey });
    await purgeLegacyLocalData({ ownerScopeKey });

    expect(mockedClearPhotos).toHaveBeenCalledTimes(1);
    expect(mockedRetainPhotos).toHaveBeenCalledTimes(2);
    expect(mockedRetainPhotos).toHaveBeenLastCalledWith(ownerScopeKey);
    expect(mockedPurgeQueue).toHaveBeenCalledTimes(2);
    expect(mockedPurgeOutbox).toHaveBeenCalledTimes(2);
    expect(await AsyncStorage.getItem('@labelscan:local-data-migration')).toBe('3');
  });

  it('fails closed when another scope photo directory cannot be pruned', async () => {
    mockedRetainPhotos.mockRejectedValueOnce(new Error('filesystem unavailable'));

    await expect(purgeLegacyLocalData({
      failClosed: true,
      ownerScopeKey: 'org-b:actor-b:portal-b:boucherie',
    })).rejects.toThrow('LOCAL_SESSION_PURGE_FAILED');
  });

  it('continues every purge step but rejects the transition when one store fails', async () => {
    mockedClearQueue.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(clearLocalSessionData()).rejects.toThrow('LOCAL_SESSION_PURGE_FAILED');
    expect(mockedClearOutbox).toHaveBeenCalledTimes(1);
    expect(mockedClearPhotos).toHaveBeenCalledTimes(1);
  });
});
