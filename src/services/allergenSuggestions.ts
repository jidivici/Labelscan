/**
 * Allergen SUGGESTIONS (decision-support, NOT extraction).
 *
 * The extraction pipeline never fabricates: a value not printed on the label is left
 * null and routed to review (the no-fabrication gate). This module does NOT change
 * that. It only proposes a *suggestion* the human can accept in the review screen for
 * the `allergens` field, derived from the seafood type — which maps deterministically
 * to one of the EU Annex II allergen families (fish / crustaceans / molluscs).
 *
 * Compliance contract:
 *  - A suggestion is shown, never auto-applied. Accepting it makes it a HUMAN value
 *    (saved as an edit → `ArticleField.edited`, i.e. source='human'), never an
 *    "extracted" value. The label's own declared allergens always win when present.
 *  - A generic "fruits de mer" designation suggests both relevant families
 *    (crustaceans + molluscs), never an arbitrarily chosen single family.
 *
 * Scope is deliberately limited to allergens. Provenance/FAO are NOT suggested:
 * port→FAO is non-deterministic and a regulated field (PROMPT-CONTRACT forbids
 * mapping a place to an FAO number), so it stays human-entered only.
 */

/** Minimal shape we read — matches both ExtractionField and ArticleField. */
export interface AllergenSourceField {
  field_name: string;
  value: string | null;
}

/** EU Annex II seafood allergen families (French wording, as used in the app). */
export const ALLERGEN_FISH = 'Poisson';
export const ALLERGEN_CRUSTACEANS = 'Crustacés';
export const ALLERGEN_MOLLUSCS = 'Mollusques';

// Keyword sets are accent-free + lowercase (the input is normalized the same way).
// FR + EN common names + a few Latin genera. Curated, not exhaustive — it only needs
// to recognise the family, and the human confirms.
const CRUSTACEANS = [
  'crustace', 'crustaces',
  'crevette', 'crevettes', 'gambas', 'langoustine', 'langoustines', 'scampi',
  'homard', 'langouste', 'crabe', 'crabes', 'tourteau', 'ecrevisse', 'etrille',
  'araignee de mer', 'shrimp', 'prawn', 'prawns', 'lobster', 'crab', 'crayfish',
  'penaeus', 'litopenaeus', 'nephrops', 'homarus', 'palinurus', 'carcinus',
];
const MOLLUSCS = [
  'mollusque', 'mollusques', 'coquillage', 'coquillages',
  'moule', 'moules', 'huitre', 'huitres', 'palourde', 'palourdes', 'coque',
  'coques', 'praire', 'saint-jacques', 'petoncle', 'calmar', 'calamar', 'calamars',
  'encornet', 'seiche', 'seiches', 'poulpe', 'pieuvre', 'bulot', 'bulots',
  'bigorneau', 'bigorneaux', 'ormeau', 'mussel', 'mussels', 'oyster', 'oysters',
  'clam', 'clams', 'scallop', 'scallops', 'squid', 'calamari', 'cuttlefish',
  'octopus', 'whelk', 'winkle', 'abalone', 'mytilus', 'crassostrea', 'ostrea',
  'ruditapes', 'pecten', 'loligo', 'sepia', 'haliotis',
];
const FISH = [
  'poisson', 'cabillaud', 'morue', 'saumon', 'truite', 'thon', 'bar', 'loup',
  'dorade', 'daurade', 'lieu', 'colin', 'merlu', 'maquereau', 'hareng', 'sardine',
  'sardines', 'anchois', 'sole', 'limande', 'plie', 'carrelet', 'raie', 'lotte',
  'baudroie', 'eglefin', 'aiglefin', 'haddock', 'fletan', 'espadon', 'rouget',
  'merlan', 'julienne', 'empereur', 'vivaneau', 'tilapia', 'pangasius', 'perche',
  'sandre', 'brochet', 'fish', 'cod', 'salmon', 'tuna', 'trout', 'sea bass',
  'seabass', 'sea bream', 'seabream', 'pollock', 'hake', 'mackerel', 'herring',
  'anchovy', 'plaice', 'skate', 'monkfish', 'halibut', 'swordfish', 'mullet',
  'whiting', 'gadus', 'salmo', 'oncorhynchus', 'thunnus', 'dicentrarchus',
  'sparus', 'pollachius', 'merluccius', 'scomber', 'clupea', 'sardina', 'engraulis',
  'solea', 'pleuronectes', 'raja', 'lophius', 'melanogrammus', 'hippoglossus',
  'xiphias',
];

// In ordinary French labelling, "fruits de mer" covers crustaceans and molluscs.
const GENERIC_SEAFOOD_MIX = /(fruits? de mer|seafood mix|mixed seafood)/;

function normalize(s: string): string {
  // NFD splits an accented letter into a base char + a combining diacritic; we
  // then drop those combining marks (Unicode block U+0300–U+036F). Filtering by
  // code point (plain hex literals) keeps the source free of the invisible
  // combining characters a literal regex range would carry.
  const decomposed = s.toLowerCase().normalize('NFD');
  let out = '';
  for (const ch of decomposed) {
    const code = ch.charCodeAt(0);
    if (code >= 0x300 && code <= 0x36f) continue; // skip NFD combining diacritics
    out += ch;
  }
  return out;
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => new RegExp(`(^|[^a-z])${kw}([^a-z]|$)`).test(text));
}

/**
 * Suggest an EU allergen family from the product/species text, or null when unclear.
 * Reads scientific_name / product_name / commercial_designation only. Crustaceans and
 * Multiple detected families are all suggested; the operator still explicitly accepts
 * the proposal before anything is saved.
 */
export function suggestAllergen(fields: AllergenSourceField[]): string | null {
  const text = normalize(
    fields
      .filter((f) =>
        ['scientific_name', 'product_name', 'commercial_designation'].includes(
          f.field_name,
        ),
      )
      .map((f) => f.value ?? '')
      .join(' '),
  );
  if (!text.trim()) return null;
  const suggestions: string[] = [];
  if (matchesAny(text, FISH)) suggestions.push(ALLERGEN_FISH);
  if (matchesAny(text, CRUSTACEANS) || GENERIC_SEAFOOD_MIX.test(text)) {
    suggestions.push(ALLERGEN_CRUSTACEANS);
  }
  if (matchesAny(text, MOLLUSCS) || GENERIC_SEAFOOD_MIX.test(text)) {
    suggestions.push(ALLERGEN_MOLLUSCS);
  }
  return suggestions.length > 0 ? suggestions.join(', ') : null;
}
