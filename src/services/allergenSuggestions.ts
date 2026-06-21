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
 *  - When the seafood type is unclear or ambiguous (e.g. a "fruits de mer" mix), we
 *    return null — we never guess.
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
  'crevette', 'crevettes', 'gambas', 'langoustine', 'langoustines', 'scampi',
  'homard', 'langouste', 'crabe', 'crabes', 'tourteau', 'ecrevisse', 'etrille',
  'araignee de mer', 'shrimp', 'prawn', 'prawns', 'lobster', 'crab', 'crayfish',
  'penaeus', 'litopenaeus', 'nephrops', 'homarus', 'palinurus', 'carcinus',
];
const MOLLUSCS = [
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

// Mixed-seafood wording: too ambiguous to attribute a single family → never guess.
const MIXED = /(fruits de mer|melange|assortiment|seafood mix|mixed seafood|cocktail)/;

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
 * molluscs are checked before fish (more specific), and a mixed-seafood product yields
 * null (no guess).
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
  if (MIXED.test(text)) return null;
  if (matchesAny(text, CRUSTACEANS)) return ALLERGEN_CRUSTACEANS;
  if (matchesAny(text, MOLLUSCS)) return ALLERGEN_MOLLUSCS;
  if (matchesAny(text, FISH)) return ALLERGEN_FISH;
  return null;
}
