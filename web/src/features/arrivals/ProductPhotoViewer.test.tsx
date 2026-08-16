import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProductPhotoViewer } from './ProductPhotoViewer';

describe('ProductPhotoViewer', () => {
  it('affiche la photo agrandie sans contrôle de rotation', () => {
    render(<ProductPhotoViewer url="blob:photo" onClose={vi.fn()} />);

    expect(screen.getByAltText('Étiquette du produit agrandie')).toHaveStyle({
      transform: 'rotate(-90deg) scale(1.4)',
    });
    expect(screen.queryByRole('button', { name: /Tourner la photo/ })).not.toBeInTheDocument();
  });

  it('se ferme avec la touche Échap', () => {
    const onClose = vi.fn();
    render(<ProductPhotoViewer url="blob:photo" onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ne tourne pas une nouvelle photo paysage déjà stockée droite', () => {
    render(<ProductPhotoViewer url="blob:landscape" baseRotationDegrees={0} onClose={vi.fn()} />);
    const image = screen.getByAltText('Étiquette du produit agrandie');

    expect(image).toHaveStyle({ transform: 'rotate(0deg) scale(1.4)' });
  });
});
