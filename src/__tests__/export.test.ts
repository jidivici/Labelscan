import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { apiTextRequest } from '../services/api';
import { exportAsCSV, exportAsJSON } from '../services/export';

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(),
  shareAsync: jest.fn(),
}));
jest.mock('../services/api', () => ({
  apiTextRequest: jest.fn(),
}));

const mockedApiTextRequest = apiTextRequest as jest.MockedFunction<typeof apiTextRequest>;
const mockedIsAvailable = Sharing.isAvailableAsync as jest.MockedFunction<
  typeof Sharing.isAvailableAsync
>;
const mockedShare = Sharing.shareAsync as jest.MockedFunction<typeof Sharing.shareAsync>;

describe('secure backend catalogue export', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockedApiTextRequest.mockReset();
    mockedIsAvailable.mockReset();
    mockedShare.mockReset();
    mockedApiTextRequest.mockResolvedValue('safe export');
    mockedIsAvailable.mockResolvedValue(true);
    mockedShare.mockResolvedValue(undefined);
  });

  it('downloads the server export and removes the temporary file after sharing', async () => {
    const write = jest.spyOn(FileSystem, 'writeAsStringAsync');
    const remove = jest.spyOn(FileSystem, 'deleteAsync');

    await exportAsCSV();

    expect(mockedApiTextRequest).toHaveBeenCalledWith('/v1/arrivals/export?format=csv', {
      timeoutMs: 60_000,
    });
    const path = write.mock.calls[0][0];
    expect(path).toMatch(/^file:\/\/\/mock-cache\/labelscan-export-\d+\.csv$/);
    expect(mockedShare).toHaveBeenCalledWith(path, expect.objectContaining({ mimeType: 'text/csv' }));
    expect(remove).toHaveBeenCalledWith(path, { idempotent: true });
  });

  it('removes the temporary file when sharing fails or is cancelled', async () => {
    mockedShare.mockRejectedValue(new Error('cancelled'));
    const write = jest.spyOn(FileSystem, 'writeAsStringAsync');
    const remove = jest.spyOn(FileSystem, 'deleteAsync');

    await expect(exportAsJSON()).rejects.toThrow('cancelled');

    expect(remove).toHaveBeenCalledWith(write.mock.calls[0][0], { idempotent: true });
  });

  it('attempts cleanup even when writing the temporary file fails', async () => {
    const write = jest
      .spyOn(FileSystem, 'writeAsStringAsync')
      .mockRejectedValue(new Error('disk full'));
    const remove = jest.spyOn(FileSystem, 'deleteAsync');

    await expect(exportAsCSV()).rejects.toThrow('disk full');

    expect(remove).toHaveBeenCalledWith(write.mock.calls[0][0], { idempotent: true });
    expect(mockedShare).not.toHaveBeenCalled();
  });
});
