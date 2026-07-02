import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import NoteImageGallery from '../src/components/NoteImageGallery';
import type { NoteImage } from '@jot/shared';

jest.mock('../src/hooks/useActiveServerBaseUrl', () => ({
  useActiveServerBaseUrl: () => 'http://test-server',
}));

function makeImage(overrides: Partial<NoteImage> = {}): NoteImage {
  return {
    id: 'img-1',
    filename: 'photo.png',
    content_type: 'image/png',
    width: 800,
    height: 600,
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('NoteImageGallery', () => {
  it('renders nothing when there are no images', () => {
    const { toJSON } = render(<NoteImageGallery images={[]} />);
    expect(toJSON()).toBeNull();
  });

  it('renders a full-width banner for a single image', () => {
    const image = makeImage();
    const { getByTestId, queryByTestId } = render(<NoteImageGallery images={[image]} />);

    expect(getByTestId('note-image-banner-container')).toBeTruthy();
    expect(getByTestId(`note-image-banner-${image.id}`)).toBeTruthy();
    expect(queryByTestId('note-image-grid')).toBeNull();
  });

  it('renders a 2-column grid for two or more images', () => {
    const images = [makeImage({ id: 'img-1' }), makeImage({ id: 'img-2' })];
    const { getByTestId, queryByTestId } = render(<NoteImageGallery images={images} />);

    expect(getByTestId('note-image-grid')).toBeTruthy();
    expect(getByTestId('note-image-grid-tile-img-1')).toBeTruthy();
    expect(getByTestId('note-image-grid-tile-img-2')).toBeTruthy();
    expect(queryByTestId('note-image-banner-container')).toBeNull();
  });

  it('folds images beyond the visible tile count into a "+N" overlay tile', () => {
    const images = Array.from({ length: 6 }, (_, i) => makeImage({ id: `img-${i + 1}` }));
    const { getByTestId, getByText, queryByTestId } = render(<NoteImageGallery images={images} />);

    // 4 tiles are shown; the 4th becomes the overlay for the remaining 2 images.
    expect(getByTestId('note-image-overlay-img-4')).toBeTruthy();
    expect(getByText('+3')).toBeTruthy();
    expect(queryByTestId('note-image-grid-tile-img-5')).toBeNull();
  });

  it('opens the lightbox at the tapped image index', () => {
    const images = [makeImage({ id: 'img-1' }), makeImage({ id: 'img-2' })];
    const { getByTestId, queryByTestId } = render(<NoteImageGallery images={images} />);

    expect(queryByTestId('image-lightbox')).toBeNull();

    fireEvent.press(getByTestId('note-image-grid-tile-img-2'));

    expect(getByTestId('image-lightbox')).toBeTruthy();
    expect(getByTestId('lightbox-page-img-2')).toBeTruthy();
  });

  it('closes the lightbox when its close button is pressed', () => {
    const images = [makeImage({ id: 'img-1' })];
    const { getByTestId, queryByTestId } = render(<NoteImageGallery images={images} />);

    fireEvent.press(getByTestId('note-image-banner-img-1'));
    expect(getByTestId('image-lightbox')).toBeTruthy();

    fireEvent.press(getByTestId('lightbox-close'));
    expect(queryByTestId('image-lightbox')).toBeNull();
  });
});
