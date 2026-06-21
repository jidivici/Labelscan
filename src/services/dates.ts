/**
 * App-wide date formatting (French) — ONE source of truth so every registration /
 * arrivage date renders identically across the app and never shows "Invalid date".
 *
 *  - formatDate:      long, human  → "20 juin 2026"  (headers, fiches produit, cartes)
 *  - formatDateShort: numeric      → "20/06/2026"    (tableaux/lignes denses)
 *
 * A missing or malformed value falls back to **today** (the system reference date)
 * rather than surfacing a technical "Invalid Date" string to the poissonnier.
 */

function toSafeDate(value?: string | null): Date {
  const d = value ? new Date(value) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Long French date, e.g. "20 juin 2026". */
export function formatDate(value?: string | null): string {
  return toSafeDate(value).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Short numeric French date for dense rows, e.g. "20/06/2026". */
export function formatDateShort(value?: string | null): string {
  return toSafeDate(value).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
