import { thumbnailPhotoUri } from '../services/photoVariants';

describe('thumbnailPhotoUri', () => {
  it('requests the compact derivative for a catalogue photo', () => {
    expect(thumbnailPhotoUri('https://api.test/v1/arrivals/batch-1/image')).toBe(
      'https://api.test/v1/arrivals/batch-1/image?variant=thumbnail',
    );
  });

  it('preserves local scan photos', () => {
    expect(thumbnailPhotoUri('file:///documents/pending/scan.jpg')).toBe(
      'file:///documents/pending/scan.jpg',
    );
  });
});
