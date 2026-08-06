import { render, fireEvent } from '@testing-library/react-native';
import ImageLightbox from '../src/components/ImageLightbox';
import type { NoteImage } from '@jot/shared';

jest.mock('../src/hooks/useActiveServerBaseUrl', () => ({
  useActiveServerBaseUrl: () => 'http://test-server',
}));

function makeImage(id: string): NoteImage {
  return {
    id,
    filename: `${id}.png`,
    content_type: 'image/png',
    width: 800,
    height: 600,
    created_at: '2024-01-01T00:00:00Z',
  };
}

const images = [makeImage('img-1'), makeImage('img-2'), makeImage('img-3')];

describe('ImageLightbox', () => {
  it('renders nothing when index is null (closed)', () => {
    const { toJSON, queryByTestId } = render(
      <ImageLightbox images={images} index={null} onIndexChange={jest.fn()} onClose={jest.fn()} />,
    );

    expect(toJSON()).toBeNull();
    expect(queryByTestId('image-lightbox')).toBeNull();
  });

  it('renders the image at the given index when open', () => {
    const { getByTestId } = render(
      <ImageLightbox images={images} index={1} onIndexChange={jest.fn()} onClose={jest.fn()} />,
    );

    expect(getByTestId('image-lightbox')).toBeTruthy();
    expect(getByTestId('lightbox-page-img-2')).toBeTruthy();
    expect(getByTestId('lightbox-counter').props.children).toBe('2 / 3');
  });

  it('calls onClose when the close button is pressed', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <ImageLightbox images={images} index={0} onIndexChange={jest.fn()} onClose={onClose} />,
    );

    fireEvent.press(getByTestId('lightbox-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates forward and backward (wrapping) via the chevron buttons', () => {
    const onIndexChange = jest.fn();
    const { getByTestId } = render(
      <ImageLightbox images={images} index={0} onIndexChange={onIndexChange} onClose={jest.fn()} />,
    );

    fireEvent.press(getByTestId('lightbox-next'));
    expect(onIndexChange).toHaveBeenCalledWith(1);

    fireEvent.press(getByTestId('lightbox-previous'));
    expect(onIndexChange).toHaveBeenCalledWith(images.length - 1);
  });

  it('hides navigation controls and the counter for a single image', () => {
    const { queryByTestId } = render(
      <ImageLightbox images={[images[0]]} index={0} onIndexChange={jest.fn()} onClose={jest.fn()} />,
    );

    expect(queryByTestId('lightbox-next')).toBeNull();
    expect(queryByTestId('lightbox-previous')).toBeNull();
    expect(queryByTestId('lightbox-counter')).toBeNull();
  });

  it('clamps to the last image when the index falls out of range (e.g. after a live removal)', () => {
    const { getByTestId } = render(
      <ImageLightbox images={images} index={99} onIndexChange={jest.fn()} onClose={jest.fn()} />,
    );

    expect(getByTestId('lightbox-page-img-3')).toBeTruthy();
  });
});
