const store: Record<string, string> = {};

export default {
  getItem: jest.fn((key: string) => Promise.resolve(store[key] ?? null)),
  setItem: jest.fn((key: string, value: string) => { store[key] = value; return Promise.resolve(); }),
  removeItem: jest.fn((key: string) => { delete store[key]; return Promise.resolve(); }),
  clear: jest.fn(() => { for (const k of Object.keys(store)) delete store[k]; return Promise.resolve(); }),
  // Batch ops used by the per-key ArticleStore adapter (audit §7.2).
  getAllKeys: jest.fn(() => Promise.resolve(Object.keys(store))),
  multiGet: jest.fn((keys: string[]) =>
    Promise.resolve(keys.map((k) => [k, store[k] ?? null] as [string, string | null])),
  ),
  multiSet: jest.fn((pairs: [string, string][]) => {
    for (const [k, v] of pairs) store[k] = v;
    return Promise.resolve();
  }),
  multiRemove: jest.fn((keys: string[]) => {
    for (const k of keys) delete store[k];
    return Promise.resolve();
  }),
};
