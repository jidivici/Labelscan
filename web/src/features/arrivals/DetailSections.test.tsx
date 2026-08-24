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
});
