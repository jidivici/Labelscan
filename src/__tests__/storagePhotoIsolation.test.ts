import * as FileSystem from 'expo-file-system/legacy';

import {
  deletePendingPhotoStrict,
  isCanonicalPendingPhotoUri,
  retainLocalArticlePhotosForScope,
} from '../services/storage';

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
});
