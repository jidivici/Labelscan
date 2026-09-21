/** Secure catalogue exports are authorized and assembled by the backend. */

import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { apiTextRequest } from './api';

type ExportFormat = 'json' | 'csv';

async function exportAndShare(format: ExportFormat): Promise<void> {
  const content = await apiTextRequest(`/v1/arrivals/export?format=${format}`, {
    timeoutMs: 60_000,
  });
  const baseDirectory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
  if (!baseDirectory) throw new Error('No writable export directory is available.');
  const path = `${baseDirectory}labelscan-export-${Date.now()}.${format}`;
  try {
    await FileSystem.writeAsStringAsync(path, content, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    if (!(await Sharing.isAvailableAsync())) {
      throw new Error('Sharing is not available on this device.');
    }
    await Sharing.shareAsync(path, {
      mimeType: format === 'json' ? 'application/json' : 'text/csv',
      dialogTitle: 'Exporter les arrivages LabelScan',
      UTI: format === 'json' ? 'public.json' : 'public.comma-separated-values-text',
    });
  } finally {
    await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
  }
}

export async function exportAsJSON(): Promise<void> {
  await exportAndShare('json');
}

export async function exportAsCSV(): Promise<void> {
  await exportAndShare('csv');
}
