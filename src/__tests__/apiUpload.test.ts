/**
 * apiUpload file-existence guard — the fix for the recurring iOS
 * NSCocoaErrorDomain 260 "Camera/<uuid>.jpg no such file" at upload time.
 *
 * The outbox stores the file uri at enqueue time and replays it on drain; that uri
 * can go stale (OS-purged expo-camera Camera/ cache, ImageManipulator cache, or a
 * pending/ photo deleted after the scan was discarded). The guard checks existence at
 * the upload chokepoint and throws a non-retryable FILE_NOT_FOUND ApiError so the op
 * dead-letters cleanly. SDK 57 uploads also use Expo's Blob-compatible File object;
 * the former React Native `{ uri, name, type }` extension is not valid for expo/fetch.
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

  it('sends an existing image as a Blob-compatible File through expo/fetch', async () => {
    jest.resetModules();
    jest.doMock('../config', () => ({ API_BASE_URL: 'https://api.example.test' }));
    const isolatedFileSystem = await import('expo-file-system/legacy');
    jest.spyOn(isolatedFileSystem, 'getInfoAsync').mockResolvedValue({ exists: true } as never);
    const modernFileSystem = await import('expo-file-system');
    expect(typeof modernFileSystem.File).toBe('function');
    const networkFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    global.fetch = networkFetch;

    const { apiUpload: isolatedApiUpload } = await import('../services/api');
    await expect(isolatedApiUpload<{ ok: true }>(
      '/v1/ingestions',
      {
        file: {
          uri: 'file:///mock-documents/pending/scan.jpg',
          name: 'label.jpg',
          type: 'image/jpeg',
        },
        fields: { client_captured_at: '2026-09-06T12:00:00Z' },
      },
      { skipAuth: true, correlationId: 'correlation-1' },
    )).resolves.toEqual({ ok: true });

    const [, init] = networkFetch.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    const image = form.get('image');
    expect(image).toBeInstanceOf(Blob);
    expect((image as File).name).toBe('label.jpg');
    expect(form.get('client_captured_at')).toBe('2026-09-06T12:00:00Z');
  });
});
