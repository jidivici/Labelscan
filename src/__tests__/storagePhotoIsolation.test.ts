import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';

import {
  deletePendingPhotoStrict,
  isCanonicalPendingPhotoUri,
  retainLocalArticlePhotosForScope,
  cacheRemoteArticlePhoto,
  getCachedRemoteArticlePhoto,
  clearLocalArticlePhotos,
} from '../services/storage';
import { setOperatorContext, captureActiveSession, invalidateActiveSessionWork } from '../services/authStorage';

const mockFs = FileSystem as typeof FileSystem & {
  __reset: () => void;
  __seedFile: (uri: string) => void;
  __seedDirectory: (uri: string) => void;
};

describe('photo cache path isolation', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockFs.__reset();
  });

  it('accepts only a direct safe JPEG child for pending-photo deletion', async () => {
    const safe = `${FileSystem.documentDirectory}pending/scan-123.jpg`;
    const escaped = `${FileSystem.documentDirectory}pending/../private.jpg`;
    mockFs.__seedFile(safe);
    mockFs.__seedFile(`${FileSystem.documentDirectory}private.jpg`);
    const remove = jest.spyOn(FileSystem, 'deleteAsync');

    expect(isCanonicalPendingPhotoUri(safe)).toBe(true);
    expect(isCanonicalPendingPhotoUri(escaped)).toBe(false);
    expect(isCanonicalPendingPhotoUri(`${FileSystem.documentDirectory}pending/a%2fb.jpg`)).toBe(false);
    await deletePendingPhotoStrict(escaped);

    expect(remove).not.toHaveBeenCalled();
  });

  it('retains only the exact validated scope directory on cold start', async () => {
    const root = `${FileSystem.documentDirectory}photos/`;
    const keep = encodeURIComponent('org-a:actor-a:portal-a:poissonnerie');
    const foreign = encodeURIComponent('org-b:actor-b:portal-b:boucherie');
    mockFs.__seedDirectory(root);
    mockFs.__seedDirectory(`${root}${keep}/`);
    mockFs.__seedDirectory(`${root}${foreign}/`);
    mockFs.__seedFile(`${root}${keep}/ing-a.jpg`);
    mockFs.__seedFile(`${root}${foreign}/ing-b.jpg`);
    const remove = jest.spyOn(FileSystem, 'deleteAsync');

    await retainLocalArticlePhotosForScope('org-a:actor-a:portal-a:poissonnerie');

    expect(remove).toHaveBeenCalledWith(`${root}${foreign}`, { idempotent: true });
    expect(remove).not.toHaveBeenCalledWith(`${root}${keep}`, expect.anything());
  });

  it('writes binary downloads in the operator scope and purges them on logout', async () => {
    await setOperatorContext({ organizationId: 'org', actorId: 'actor', businessPortalId: 'portal', tradeCode: 'poissonnerie' });
    const fence = (await captureActiveSession())!;
    const bytes = new Uint8Array([255, 216, 255, 217]);
    const write = jest.spyOn(File.prototype, 'write');
    const uri = await cacheRemoteArticlePhoto('batch-a', bytes, fence);
    expect(uri).toBe(`${FileSystem.documentDirectory}photos/org%3Aactor%3Aportal%3Apoissonnerie/remote-batch-a.jpg`);
    expect(write).toHaveBeenCalledWith(bytes);
    await expect(getCachedRemoteArticlePhoto('batch-a', fence)).resolves.toBe(uri);
    invalidateActiveSessionWork();
    await clearLocalArticlePhotos();
    await expect(FileSystem.getInfoAsync(uri)).resolves.toEqual({ exists: false });
    await expect(cacheRemoteArticlePhoto('batch-a', bytes, fence)).rejects.toThrow('MOBILE_SESSION_CHANGED');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does not write a late download if logout occurs while creating its directory', async () => {
    await setOperatorContext({ organizationId: 'org', actorId: 'actor', businessPortalId: 'portal', tradeCode: 'poissonnerie' });
    const fence = (await captureActiveSession())!;
    jest.spyOn(FileSystem, 'makeDirectoryAsync').mockImplementationOnce(async () => {
      invalidateActiveSessionWork();
    });
    const write = jest.spyOn(File.prototype, 'write');
    await expect(cacheRemoteArticlePhoto('batch-a', new Uint8Array([1]), fence)).rejects.toThrow('MOBILE_SESSION_CHANGED');
    expect(write).not.toHaveBeenCalled();
  });
});
