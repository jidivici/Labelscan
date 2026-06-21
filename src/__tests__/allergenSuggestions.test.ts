import {
  suggestAllergen,
  ALLERGEN_FISH,
  ALLERGEN_CRUSTACEANS,
  ALLERGEN_MOLLUSCS,
  type AllergenSourceField,
} from '../services/allergenSuggestions';

/** Build the minimal field list suggestAllergen reads. */
function fields(
  partial: Partial<Record<string, string | null>>,
): AllergenSourceField[] {
  return Object.entries(partial).map(([field_name, value]) => ({
    field_name,
    value: value ?? null,
  }));
}

describe('suggestAllergen — EU Annex II family from species/product text', () => {
  it('maps a fish common name to Poisson', () => {
    expect(suggestAllergen(fields({ product_name: 'Filet de cabillaud' }))).toBe(
      ALLERGEN_FISH,
    );
  });

  it('maps a fish scientific name to Poisson', () => {
    expect(suggestAllergen(fields({ scientific_name: 'Gadus morhua' }))).toBe(
      ALLERGEN_FISH,
    );
  });

  it('maps a crustacean common name to Crustacés', () => {
    expect(suggestAllergen(fields({ product_name: 'Crevettes roses cuites' }))).toBe(
      ALLERGEN_CRUSTACEANS,
    );
  });

  it('maps a crustacean genus to Crustacés', () => {
    expect(suggestAllergen(fields({ scientific_name: 'Penaeus monodon' }))).toBe(
      ALLERGEN_CRUSTACEANS,
    );
  });

  it('maps a mollusc common name to Mollusques', () => {
    expect(suggestAllergen(fields({ commercial_designation: 'Moules de bouchot' }))).toBe(
      ALLERGEN_MOLLUSCS,
    );
    expect(suggestAllergen(fields({ product_name: 'Calamars à la romaine' }))).toBe(
      ALLERGEN_MOLLUSCS,
    );
  });

  it('is accent- and case-insensitive (NFD diacritics stripped)', () => {
    // "Huîtres" → normalized "huitres" matches the accent-free keyword (î stripped).
    expect(suggestAllergen(fields({ product_name: 'Huîtres de Bretagne' }))).toBe(
      ALLERGEN_MOLLUSCS,
    );
    // Uppercase + an accented neighbouring word must not break the match.
    expect(
      suggestAllergen(fields({ product_name: 'CABILLAUD décongelé' })),
    ).toBe(ALLERGEN_FISH);
  });

  it('prefers the more specific family: crustacean wins over fish', () => {
    // Mentions both a crustacean (homard) and a fish (poisson) → Crustacés.
    expect(
      suggestAllergen(fields({ product_name: 'Bisque de homard et de poisson' })),
    ).toBe(ALLERGEN_CRUSTACEANS);
  });

  it('returns null for a mixed-seafood product (never guesses a single family)', () => {
    expect(
      suggestAllergen(fields({ product_name: 'Assortiment de fruits de mer' })),
    ).toBeNull();
    expect(
      suggestAllergen(fields({ commercial_designation: 'Cocktail de fruits de mer' })),
    ).toBeNull();
  });

  it('returns null when no seafood term is present', () => {
    expect(suggestAllergen(fields({ product_name: 'Filet de poulet fermier' }))).toBeNull();
  });

  it('returns null for empty / whitespace / no relevant fields', () => {
    expect(suggestAllergen([])).toBeNull();
    expect(suggestAllergen(fields({ product_name: '   ' }))).toBeNull();
    expect(suggestAllergen(fields({ product_name: null }))).toBeNull();
  });

  it('reads only species/product fields, not other fields', () => {
    // A seafood term in a non-source field (e.g. batch_number) must not trigger.
    expect(
      suggestAllergen(fields({ batch_number: 'CRABE-2024', product_name: 'Plat préparé' })),
    ).toBeNull();
  });

  it('respects word boundaries (no substring false positives)', () => {
    // "barbecue" must not match the fish keyword "bar".
    expect(suggestAllergen(fields({ product_name: 'Plateau barbecue' }))).toBeNull();
  });

  it('exposes the EU family constants in French', () => {
    expect(ALLERGEN_FISH).toBe('Poisson');
    expect(ALLERGEN_CRUSTACEANS).toBe('Crustacés');
    expect(ALLERGEN_MOLLUSCS).toBe('Mollusques');
  });
});
