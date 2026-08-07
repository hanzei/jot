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

  it('keeps a portrait image banner full width instead of shrinking to fit its aspect ratio', () => {
    // Portrait image (taller than wide) whose natural height at full
    // container width would exceed the banner's max height.
    const image = makeImage({ width: 600, height: 1200 });
    const { getByTestId } = render(<NoteImageGallery images={[image]} />);

    const container = getByTestId('note-image-banner-container');
    fireEvent(container, 'layout', { nativeEvent: { layout: { width: 320, height: 0, x: 0, y: 0 } } });

    // The tile View (the container's only child) carries the sizing style;
    // the inner TouchableOpacity just fills whatever box that resolves to.
    const tileView = container.children[0]!;
    if (typeof tileView === 'string') throw new Error('expected a host element, got a text node');
    const style = Object.assign({}, ...[tileView.props.style].flat(Infinity).filter(Boolean));
    expect(style.width).toBe('100%');
    expect(style.aspectRatio).toBeUndefined();
    expect(style.height).toBeLessThanOrEqual(240);
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

  describe('editable mode', () => {
    it('does not render a remove button when not editable', () => {
      const { queryByTestId } = render(<NoteImageGallery images={[makeImage()]} onRemove={jest.fn()} />);
      expect(queryByTestId('remove-image-img-1')).toBeNull();
    });

    it('calls onRemove with the tapped image', () => {
      const onRemove = jest.fn();
      const image = makeImage();
      const { getByTestId } = render(<NoteImageGallery images={[image]} editable onRemove={onRemove} />);

      fireEvent.press(getByTestId('remove-image-img-1'));

      expect(onRemove).toHaveBeenCalledWith(image);
    });

    it('does not render a remove button on the "+N" overlay tile', () => {
      const images = Array.from({ length: 5 }, (_, i) => makeImage({ id: `img-${i + 1}` }));
      const { queryByTestId } = render(<NoteImageGallery images={images} editable onRemove={jest.fn()} />);
      expect(queryByTestId('remove-image-img-4')).toBeNull();
    });
  });

  describe('pending uploads', () => {
    function makeUpload(overrides: Partial<{ id: string; filename: string; previewUri: string; progress: number; status: 'uploading' | 'error'; errorMessage?: string }> = {}) {
      return {
        id: 'upload-1',
        filename: 'new.png',
        previewUri: 'file:///new.png',
        progress: 0,
        status: 'uploading' as const,
        ...overrides,
      };
    }

    it('renders an uploading tile with progress', () => {
      const { getByTestId, getByText } = render(
        <NoteImageGallery images={[]} editable uploads={[makeUpload({ progress: 42 })]} />,
      );
      expect(getByTestId('image-upload-tile-upload-1')).toBeTruthy();
      expect(getByText('Uploading… 42%')).toBeTruthy();
    });

    it('lets an in-flight upload be cancelled from its tile (issue #695)', () => {
      const onDismissUpload = jest.fn();
      const { getByTestId } = render(
        <NoteImageGallery
          images={[]}
          editable
          uploads={[makeUpload({ progress: 42 })]}
          onDismissUpload={onDismissUpload}
        />,
      );

      fireEvent.press(getByTestId('dismiss-upload-upload-1'));

      expect(onDismissUpload).toHaveBeenCalledWith('upload-1');
    });

    it('does not render a cancel button on an uploading tile without an onDismissUpload handler', () => {
      const { queryByTestId } = render(
        <NoteImageGallery images={[]} editable uploads={[makeUpload({ progress: 42 })]} />,
      );
      expect(queryByTestId('dismiss-upload-upload-1')).toBeNull();
    });

    it('renders an errored upload with retry and dismiss actions', () => {
      const onRetryUpload = jest.fn();
      const onDismissUpload = jest.fn();
      const upload = makeUpload({ status: 'error', errorMessage: 'Upload failed' });
      const { getByTestId } = render(
        <NoteImageGallery images={[]} editable uploads={[upload]} onRetryUpload={onRetryUpload} onDismissUpload={onDismissUpload} />,
      );

      fireEvent.press(getByTestId('retry-upload-upload-1'));
      expect(onRetryUpload).toHaveBeenCalledWith('upload-1');

      fireEvent.press(getByTestId('dismiss-upload-upload-1'));
      expect(onDismissUpload).toHaveBeenCalledWith('upload-1');
    });

    it('sorts upload tiles before persisted images', () => {
      const image = makeImage({ id: 'img-1' });
      const upload = makeUpload();
      const { toJSON } = render(<NoteImageGallery images={[image]} editable uploads={[upload]} />);

      // Two tiles means the grid layout renders, and the grid tile ordering
      // (uploads first) matches the webapp so an in-flight upload never falls
      // out of the visible window once a note already has several images.
      const tree = JSON.stringify(toJSON());
      expect(tree.indexOf('image-upload-tile-upload-1')).toBeLessThan(tree.indexOf('note-image-grid-tile-img-1'));
    });
  });
});
