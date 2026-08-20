/**
 * French (poissonnerie / criée) labels for the extraction fields, plus French
 * renderings of the validation statuses. PRESENTATION ONLY — the canonical field
 * keys (English, from extraction.v1) and the stored validation_status values are
 * unchanged; this just maps them to professional French for the review screen.
 */

import { displayDate, isDateField } from './inputMasks';

const FIELD_LABELS_FR: Record<string, string> = {
  commercial_designation: 'Dénomination commerciale',
  scientific_name: 'Nom scientifique',
  producer_name: 'Producteur',
  reseller_brand: 'Marque de revente',
  batch_number: 'N° de lot',
  origin_country: "Pays d'origine",
  FAO_area: 'Zone de pêche (FAO)',
  production_method: 'Méthode de production',
  fishing_gear_or_farming_method: "Engin de pêche / d'élevage",
  expiry_date: 'Date limite de consommation',
  packaging_date: "Date d'emballage",
  storage_temperature: 'Température de conservation',
  allergens: 'Allergènes',
  health_mark: 'Estampille sanitaire',
  weight: 'Poids',
  price: 'Prix',
  gtin: 'Code-barres (GTIN)',
  // Boucherie V1
  animal_species: 'Espèce animale',
  animal_category: 'Catégorie animale',
  cut_name: 'Morceau / découpe',
  birth_country: 'Pays de naissance',
  rearing_country: "Pays d’élevage",
  slaughter_country: "Pays d’abattage",
  cutting_country: 'Pays de découpe',
  slaughterhouse_approval: "Agrément de l’abattoir",
  cutting_plant_approval: "Agrément de l’atelier de découpe",
  // Charcuterie / traiteur V1
  product_family: 'Famille de produit',
  description: 'Description',
  product_description: 'Description du produit',
  manufacturer_name: 'Fabricant',
  ingredients: 'Ingrédients',
  additives: 'Additifs',
  preparation_date: 'Date de préparation',
  conditioning_type: 'Type de conditionnement',
  storage_mode: 'Mode de conservation',
  use_instructions: "Conseils d’utilisation",
  reheating_instructions: 'Instructions de réchauffage',
  raw_warnings: 'Observations',
  // legacy v1 keys, kept so historical records still render a French label
  product_name: 'Nom du produit',
  supplier_name: 'Fournisseur',
};

/** French label for a field key (falls back to the raw key if unmapped). */
export function fieldLabelFr(fieldName: string): string {
  return FIELD_LABELS_FR[fieldName] ?? fieldName;
}

/** Ingestion lifecycle status → short professional French (no technical code shown).
 * Covers the full 12-state machine so no raw status code ever reaches the operator. */
const INGESTION_STATUS_FR: Record<string, string> = {
  raw_stored: 'Reçu',
  ocr_running: 'Lecture en cours',
  ocr_done: 'Analyse en cours',
  ocr_failed: 'Échec de lecture',
  ocr_skipped_garbage: 'Illisible',
  extraction_running: 'Analyse en cours',
  extracted: 'Extrait',
  extraction_failed: 'Échec',
  needs_review: 'À vérifier',
  confirmed: 'Validé',
  rejected: 'Rejeté',
  halted_missing_context: 'Interrompu',
};

export function ingestionStatusFr(status: string): string {
  return INGESTION_STATUS_FR[status] ?? status;
}

/** Controlled production-method value → French (for display AND omni-search). */
const PRODUCTION_METHOD_FR: Record<string, string> = {
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
  // Dates are stored canonical ISO (audit §7.2 step 4); render DD/MM/YYYY. displayDate
  // passes through anything not ISO, so legacy DD/MM/YYYY records still display correctly.
  if (value != null && isDateField(fieldName)) return displayDate(value);
  return value;
}
