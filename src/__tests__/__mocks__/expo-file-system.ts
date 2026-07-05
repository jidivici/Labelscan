/**
 * Minimal in-memory expo-file-system/legacy mock so services that touch the photo
 * store (storage.ts, pulled in transitively by scanQueue.ts) can be imported/tested
 * under Node/jest without a native module. No test currently asserts on file bytes;
 * this only needs to keep existence/copy/delete bookkeeping consistent.
 */

export const documentDirectory = 'file:///mock-documents/';

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

export async function deleteAsync(uri: string): Promise<void> {
  files.delete(uri);
  dirs.delete(uri);
}

export async function readDirectoryAsync(dirUri: string): Promise<string[]> {
  const names: string[] = [];
  for (const f of files) {
    if (f.startsWith(dirUri)) names.push(f.slice(dirUri.length));
  }
  return names;
}

// Test-only helpers to seed/reset the fake filesystem between suites.
export function __reset(): void {
  files.clear();
  dirs.clear();
}
export function __seedFile(uri: string): void {
  files.add(uri);
}
