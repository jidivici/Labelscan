/**
 * apiUpload file-existence guard — the fix for the recurring iOS
 * NSCocoaErrorDomain 260 "Camera/<uuid>.jpg no such file" at upload time.
 *
 * The outbox stores the file uri at enqueue time and replays it on drain; that uri
 * can go stale (OS-purged expo-camera Camera/ cache, ImageManipulator cache, or a
 * pending/ photo deleted after the scan was discarded). RN's fetch then fails deep in
 * the networking stack with a non-retryable "no such file" that previously surfaced as
 * a generic retriable NETWORK_ERROR (5 scary retries). The guard now checks existence
 * at the upload chokepoint and throws a non-retryable FILE_NOT_FOUND ApiError so the op
 * dead-letters cleanly.
 */

import { ApiError, apiUpload } from '../services/api';
import * as FileSystem from 'expo-file-system/legacy';

const getInfoAsyncSpy = jest.spyOn(FileSystem, 'getInfoAsync');

describe('apiUpload file-existence guard', () => {
  beforeEach(() => {
    getInfoAsyncSpy.mockReset();
  });

  it('throws a non-retryable FILE_NOT_FOUND when the upload file is gone', async () => {
    getInfoAsyncSpy.mockResolvedValue({ exists: false } as never);

    const err = await apiUpload<{ ok: true }>(
      '/v1/ingestions',
      { file: { uri: 'file:///var/.../Camera/7CA19B13.jpg', name: 'label.jpg', type: 'image/jpeg' } },
    ).then(
      () => null,
      (e) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('FILE_NOT_FOUND');
    expect((err as ApiError).retriable).toBe(false);
    expect((err as ApiError).status).toBe(0);
  });

  it('treats a getInfoAsync rejection as a non-retryable FILE_NOT_FOUND too', async () => {
    getInfoAsyncSpy.mockRejectedValue(new Error('permission denied'));

    const err = await apiUpload<{ ok: true }>(
      '/v1/ingestions',
      { file: { uri: 'file:///whatever', name: 'label.jpg', type: 'image/jpeg' } },
    ).then(
      () => null,
      (e) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('FILE_NOT_FOUND');
    expect((err as ApiError).retriable).toBe(false);
  });
});
