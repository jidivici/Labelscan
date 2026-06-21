/**
 * French (poissonnerie / criée) labels for the extraction fields, plus French
 * renderings of the validation statuses. PRESENTATION ONLY — the canonical field
 * keys (English, from extraction.v1) and the stored validation_status values are
 * unchanged; this just maps them to professional French for the review screen.
 */

export const FIELD_LABELS_FR: Record<string, string> = {
  product_name: 'Nom du produit',
  commercial_designation: 'Dénomination commerciale',
  scientific_name: 'Nom scientifique',
  batch_number: 'N° de lot',
  supplier_name: 'Fournisseur',
  origin_country: "Pays d'origine",
  FAO_area: 'Zone de pêche (FAO)',
  production_method: 'Méthode de production',
  fishing_gear_or_farming_method: "Engin de pêche / d'élevage",
  expiry_date: 'Date limite de consommation',
  packaging_date: "Date d'emballage",
  storage_temperature: 'Température de conservation',
  allergens: 'Allergènes',
  weight: 'Poids',
  price: 'Prix',
  gtin: 'Code-barres (GTIN)',
  raw_warnings: 'Observations',
};

/** French label for a field key (falls back to the raw key if unmapped). */
export function fieldLabelFr(fieldName: string): string {
  return FIELD_LABELS_FR[fieldName] ?? fieldName;
}

export const VALIDATION_STATUS_FR: Record<string, string> = {
  present: 'présent',
  missing: 'manquant',
  ambiguous: 'ambigu',
  normalized: 'normalisé',
  unnormalizable: 'non normalisable',
  invalid: 'invalide',
};

/** French rendering of a validation_status (falls back to the raw value). */
export function validationStatusFr(status: string): string {
  return VALIDATION_STATUS_FR[status] ?? status;
}

/** Ingestion lifecycle status → short professional French (no technical code shown). */
export const INGESTION_STATUS_FR: Record<string, string> = {
  raw_stored: 'Reçu',
  extracted: 'Extrait',
  needs_review: 'À vérifier',
  ocr_skipped_garbage: 'Illisible',
  extraction_failed: 'Échec',
};

export function ingestionStatusFr(status: string): string {
  return INGESTION_STATUS_FR[status] ?? status;
}

/** Controlled production-method value → French (for display AND omni-search). */
export const PRODUCTION_METHOD_FR: Record<string, string> = {
  wild_caught: 'Pêche sauvage',
  farmed: 'Élevage',
};

export function productionMethodFr(value: string | null): string | null {
  if (value == null) return value;
  return PRODUCTION_METHOD_FR[value] ?? value;
}

/**
 * Field value as it should be DISPLAYED: francizes controlled vocabulary
 * (`production_method` → Élevage / Pêche sauvage), returns the value unchanged
 * otherwise. The stored value stays canonical (English) — this is presentation only.
 *
 * NOTE — FAO_area is shown VERBATIM (full precision, e.g. "27.8.b.1") so the displayed
 * value is EXACTLY what is persisted/exported (audit §4.1). The friendly area name is a
 * decorative SECONDARY annotation in the headline only — it must never replace, nor be
 * saved in place of, the canonical designation.
 */
export function displayFieldValue(fieldName: string, value: string | null): string | null {
  if (fieldName === 'production_method') return productionMethodFr(value);
  return value;
}
