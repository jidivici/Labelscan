/**
 * App-wide date formatting (French) — ONE source of truth so every registration /
 * arrivage date renders identically across the app and never shows "Invalid date".
 *
 *  - formatDate:      long, human  → "20 juin 2026"  (headers, fiches produit, cartes)
 *  - formatDateShort: numeric      → "20/06/2026"    (tableaux/lignes denses)
 *
 * PostgreSQL currently serializes some timestamps with a space separator, six
 * fractional digits, and a short UTC offset (for example
 * `2026-08-14 15:33:10.533187+00`). Hermes is stricter than browsers when parsing
 * that representation, so normalize it before constructing a Date.
 *
 * A missing or malformed value is shown as unknown. It must never silently become
 * today: that would place a historical arrival in the wrong calendar bucket.
 */

const POSTGRES_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

function normalizeOffset(value: string): string {
  if (value === 'Z') return value;
  if (/^[+-]\d{2}$/.test(value)) return `${value}:00`;
  if (/^[+-]\d{4}$/.test(value)) return `${value.slice(0, 3)}:${value.slice(3)}`;
  return value;
}

/** Parse API and ISO timestamps consistently in Hermes, browsers, and tests. */
export function parseDateValue(value?: string | null): Date | null {
  const raw = value?.trim();
  if (!raw) return null;

  const postgres = POSTGRES_TIMESTAMP.exec(raw);
  const normalized = postgres
    ? `${postgres[1]}T${postgres[2]}.${(postgres[3] ?? '0').slice(0, 3).padEnd(3, '0')}${normalizeOffset(postgres[4])}`
    : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Long French date, e.g. "20 juin 2026". */
export function formatDate(value?: string | null): string {
  const date = parseDateValue(value);
  if (!date) return 'Date inconnue';
  return date.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Short numeric French date for dense rows, e.g. "20/06/2026". */
export function formatDateShort(value?: string | null): string {
  const date = parseDateValue(value);
  if (!date) return 'Date inconnue';
  return date.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
