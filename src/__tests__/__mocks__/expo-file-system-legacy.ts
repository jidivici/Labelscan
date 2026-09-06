/**
 * Minimal in-memory expo-file-system/legacy mock so services that touch the photo
 * store (storage.ts, pulled in transitively by scanQueue.ts) can be imported/tested
 * under Node/jest without a native module. No test currently asserts on file bytes;
 * this only needs to keep existence/copy/delete bookkeeping consistent.
 */

export const documentDirectory = 'file:///mock-documents/';
export const cacheDirectory = 'file:///mock-cache/';
export const EncodingType = { UTF8: 'utf8' } as const;

const files = new Set<string>();
const dirs = new Set<string>();

export async function getInfoAsync(uri: string): Promise<{ exists: boolean; isDirectory?: boolean }> {
  if (dirs.has(uri)) return { exists: true, isDirectory: true };
  return { exists: files.has(uri) };
}

export async function makeDirectoryAsync(uri: string): Promise<void> {
  dirs.add(uri);
}

export async function copyAsync({ to }: { from: string; to: string }): Promise<void> {
  files.add(to);
}

export async function writeAsStringAsync(uri: string): Promise<void> {
  files.add(uri);
}

export async function deleteAsync(uri: string): Promise<void> {
  for (const file of [...files]) {
    if (file === uri || file.startsWith(uri.endsWith('/') ? uri : `${uri}/`)) files.delete(file);
  }
  for (const dir of [...dirs]) {
    if (dir === uri || dir.startsWith(uri.endsWith('/') ? uri : `${uri}/`)) dirs.delete(dir);
  }
}

export async function readDirectoryAsync(dirUri: string): Promise<string[]> {
  const names = new Set<string>();
  const prefix = dirUri.endsWith('/') ? dirUri : `${dirUri}/`;
  for (const entry of [...files, ...dirs]) {
    if (!entry.startsWith(prefix) || entry === prefix) continue;
    const relative = entry.slice(prefix.length);
    const directName = relative.split('/')[0];
    if (directName) names.add(directName);
  }
  return [...names];
}

// Test-only helpers to seed/reset the fake filesystem between suites.
export function __reset(): void {
  files.clear();
  dirs.clear();
}
export function __seedFile(uri: string): void {
  files.add(uri);
}
export function __seedDirectory(uri: string): void {
  dirs.add(uri);
}
