describe('Android protected arrival photos', () => {
  let current: boolean;
  let fence: { generation: number; scopeKey: string; signal: AbortSignal };
  let fetchBytes: jest.Mock;
  let readCache: jest.Mock;
  let writeCache: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
    current = true;
    fence = { generation: 1, scopeKey: 'org:actor:portal:trade', signal: new AbortController().signal };
    fetchBytes = jest.fn().mockResolvedValue(new Uint8Array([255, 216, 255, 217]));
    readCache = jest.fn().mockResolvedValue(null);
    writeCache = jest.fn((id) => Promise.resolve(`file:///photos/${id}.jpg`));
    jest.doMock('../services/api', () => ({ apiBinaryRequest: fetchBytes }));
    jest.doMock('../services/authStorage', () => ({
      captureActiveSession: jest.fn(async () => fence),
      isSessionFenceCurrent: jest.fn((value) => current && value === fence),
    }));
    jest.doMock('../services/storage', () => ({
      getCachedRemoteArticlePhoto: readCache,
      cacheRemoteArticlePhoto: writeCache,
    }));
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    jest.dontMock('../services/api');
    jest.dontMock('../services/authStorage');
    jest.dontMock('../services/storage');
  });

  const photo = (id: string) => `https://api.example.test/v1/arrivals/${id}/image`;

  it('shares a download between card and detail and returns only a local file', async () => {
    const { loadRemoteArticlePhoto } = await import('../services/remoteArticlePhoto');
    await expect(Promise.all([loadRemoteArticlePhoto(photo('a')), loadRemoteArticlePhoto(photo('a'))]))
      .resolves.toEqual(['file:///photos/a.jpg', 'file:///photos/a.jpg']);
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(fetchBytes).toHaveBeenCalledWith('/v1/arrivals/a/image', { signal: fence.signal });
    expect(writeCache).toHaveBeenCalledWith('a', new Uint8Array([255, 216, 255, 217]), fence);
  });

  it('reuses the operator cache while offline without another download', async () => {
    readCache.mockResolvedValue('file:///photos/cached.jpg');
    const { loadRemoteArticlePhoto } = await import('../services/remoteArticlePhoto');
    await expect(loadRemoteArticlePhoto(photo('a'))).resolves.toBe('file:///photos/cached.jpg');
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('rejects foreign, query-bearing and traversal URLs before transport', async () => {
    const { loadRemoteArticlePhoto } = await import('../services/remoteArticlePhoto');
    for (const uri of [
      'https://api.example.test.evil/v1/arrivals/a/image',
      'https://api.example.test/v1/arrivals/../image',
      'https://api.example.test/v1/arrivals/%2e%2e/image',
      `${photo('a')}?token=anything`,
    ]) await expect(loadRemoteArticlePhoto(uri)).rejects.toThrow('UNTRUSTED_PHOTO_URL');
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('never persists a download completed after logout', async () => {
    let complete!: (bytes: Uint8Array) => void;
    fetchBytes.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const { loadRemoteArticlePhoto } = await import('../services/remoteArticlePhoto');
    const request = loadRemoteArticlePhoto(photo('a'));
    await new Promise((resolve) => setImmediate(resolve));
    current = false;
    complete(new Uint8Array([1]));
    await expect(request).rejects.toThrow('MOBILE_SESSION_CHANGED');
    expect(writeCache).not.toHaveBeenCalled();
  });

  it('does not cache empty or oversized image responses', async () => {
    const { loadRemoteArticlePhoto } = await import('../services/remoteArticlePhoto');
    fetchBytes.mockResolvedValueOnce(new Uint8Array()).mockResolvedValueOnce(new Uint8Array(10 * 1024 * 1024 + 1));
    await expect(loadRemoteArticlePhoto(photo('empty'))).rejects.toThrow('INVALID_PHOTO_RESPONSE');
    await expect(loadRemoteArticlePhoto(photo('oversized'))).rejects.toThrow('INVALID_PHOTO_RESPONSE');
    expect(writeCache).not.toHaveBeenCalled();
  });

  it('bounds concurrent response buffers to two and allows a failed image to be retried', async () => {
    const complete: Array<(bytes: Uint8Array) => void> = [];
    fetchBytes.mockImplementation(() => new Promise((resolve) => complete.push(resolve)));
    const { loadRemoteArticlePhoto } = await import('../services/remoteArticlePhoto');
    const requests = ['a', 'b', 'c'].map((id) => loadRemoteArticlePhoto(photo(id)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchBytes).toHaveBeenCalledTimes(2);
    complete[0](new Uint8Array([1]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchBytes).toHaveBeenCalledTimes(3);
    complete[1](new Uint8Array([1]));
    complete[2](new Uint8Array([1]));
    await Promise.all(requests);
    fetchBytes.mockRejectedValueOnce(new Error('Network failed'));
    await expect(loadRemoteArticlePhoto(photo('failed'))).rejects.toThrow('Network failed');
    fetchBytes.mockResolvedValueOnce(new Uint8Array([1]));
    await expect(loadRemoteArticlePhoto(photo('failed'))).resolves.toBe('file:///photos/failed.jpg');
  });
});
