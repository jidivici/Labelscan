/**
 * Export Service
 * Serializes articles to JSON (primary) or CSV (bonus)
 * then triggers the native share sheet via expo-sharing.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Article } from '../types/Article';

// ─── JSON Export ──────────────────────────────────────────────────────────────

export async function exportAsJSON(articles: Article[]): Promise<void> {
  const json = JSON.stringify(articles, null, 2);
  const path = `${FileSystem.documentDirectory}labelscan_export.json`;

  await FileSystem.writeAsStringAsync(path, json, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    throw new Error('Sharing is not available on this device.');
  }

  await Sharing.shareAsync(path, {
    mimeType: 'application/json',
    dialogTitle: 'Export LabelScan data',
    UTI: 'public.json',
  });
}

// ─── CSV Export (bonus) ───────────────────────────────────────────────────────

export async function exportAsCSV(articles: Article[]): Promise<void> {
  const headers = [
    'id',
    'captured_at',
    'ingestion_id',
    'extraction_run_id',
    'ingestion_status',
    'barcode_raw',
    'photo_uri',
    'fields_json', // structured fields preserved as JSON (not flattened to a blob)
  ];

  const escape = (val: string) =>
    `"${(val ?? '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;

  const rows = articles.map((a) =>
    [
      escape(a.id),
      escape(a.captured_at),
      escape(a.ingestion_id),
      escape(a.extraction_run_id ?? ''),
      escape(a.ingestion_status),
      escape(a.barcode_raw ?? ''),
      escape(a.photo_uri ?? ''),
      escape(JSON.stringify(a.fields)),
    ].join(',')
  );

  const csv = [headers.join(','), ...rows].join('\n');
  const path = `${FileSystem.documentDirectory}labelscan_export.csv`;

  await FileSystem.writeAsStringAsync(path, csv, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    throw new Error('Sharing is not available on this device.');
  }

  await Sharing.shareAsync(path, {
    mimeType: 'text/csv',
    dialogTitle: 'Export LabelScan data',
    UTI: 'public.comma-separated-values-text',
  });
}
