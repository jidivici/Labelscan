import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DetailSections } from './DetailSections';

describe('DetailSections', () => {
  it('affiche uniquement les informations produit', () => {
    render(<DetailSections
      sections={[{
        id: 'identification',
        title: 'Identification du produit',
        fields: [{ key: 'commercial_designation', label: 'Désignation commerciale', format: 'text' }],
      }]}
      fields={{ commercial_designation: 'ESPADON Longe' }}
    />);

    expect(screen.getByText('ESPADON Longe')).toBeInTheDocument();
    expect(screen.queryByText(/Human|Present/i)).not.toBeInTheDocument();
  });

  it('conserve l’ordre configuré et masque le prix des anciennes fiches', () => {
    const { container } = render(<DetailSections
      sections={[{
        id: 'commercial',
        title: 'Données commerciales',
        fields: [
          { key: 'weight', label: 'Poids', format: 'text' },
          { key: 'price', label: 'Prix', format: 'text' },
          { key: 'allergens', label: 'Allergènes', format: 'text' },
        ],
      }]}
      fields={{ weight: '3 kg', price: '8.95 EUR', allergens: 'Mollusques' }}
    />);

    expect([...container.querySelectorAll('dt')].map((node) => node.textContent)).toEqual([
      'Poids',
      'Allergènes',
    ]);
    expect(screen.queryByText('Prix')).not.toBeInTheDocument();
    expect(screen.queryByText('8.95 EUR')).not.toBeInTheDocument();
  });
});
