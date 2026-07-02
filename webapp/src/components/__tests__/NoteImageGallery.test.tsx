import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import type { NoteImage } from '@jot/shared'
import NoteImageGallery, { type PendingImageUpload } from '../NoteImageGallery'

const makeImage = (overrides: Partial<NoteImage> = {}): NoteImage => ({
  id: 'img1',
  filename: 'photo.png',
  content_type: 'image/png',
  width: 800,
  height: 600,
  created_at: '2024-01-01T00:00:00Z',
  ...overrides,
})

const makeImages = (count: number): NoteImage[] =>
  Array.from({ length: count }, (_, i) => makeImage({ id: `img${i + 1}`, filename: `photo${i + 1}.png` }))

const makeUpload = (overrides: Partial<PendingImageUpload> = {}): PendingImageUpload => ({
  id: 'upload1',
  filename: 'new.png',
  previewUrl: 'blob:new.png',
  progress: 0,
  status: 'uploading',
  ...overrides,
})

describe('NoteImageGallery', () => {
  it('renders nothing when there are no images', () => {
    const { container } = render(<NoteImageGallery images={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a full-width banner for a single image', () => {
    render(<NoteImageGallery images={[makeImage()]} />)

    expect(screen.queryByTestId('note-image-grid')).not.toBeInTheDocument()
    const img = screen.getByAltText('photo.png')
    expect(img).toHaveAttribute('src', '/api/v1/images/img1/thumbnail')
  })

  it('renders a grid for two images with no overlay', () => {
    render(<NoteImageGallery images={makeImages(2)} />)

    const grid = screen.getByTestId('note-image-grid')
    expect(grid.querySelectorAll('img')).toHaveLength(2)
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
  })

  it('shows a +N overlay on the last visible tile when images overflow the grid', () => {
    // 6 images: 3 shown clearly, 4th tile overlays the remaining 3 (images 4-6).
    render(<NoteImageGallery images={makeImages(6)} />)

    const grid = screen.getByTestId('note-image-grid')
    expect(grid.querySelectorAll('img')).toHaveLength(4)
    expect(screen.getByText('+3')).toBeInTheDocument()
  })

  it('opens the lightbox with the original image when a tile is clicked', async () => {
    const user = userEvent.setup()
    render(<NoteImageGallery images={makeImages(3)} />)

    await user.click(screen.getByRole('button', { name: 'View photo2.png' }))

    const lightboxImages = screen.getAllByAltText('photo2.png')
    expect(lightboxImages.length).toBeGreaterThan(1)
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
  })

  it('navigates to the next image with the arrow key and closes on Escape', async () => {
    const user = userEvent.setup()
    render(<NoteImageGallery images={makeImages(3)} />)

    await user.click(screen.getByRole('button', { name: 'View photo1.png' }))
    expect(screen.getByText('1 / 3')).toBeInTheDocument()

    await user.keyboard('{ArrowRight}')
    expect(screen.getByText('2 / 3')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByText('2 / 3')).not.toBeInTheDocument()
  })

  it('clamps the open lightbox to the last valid image when the gallery shrinks live', async () => {
    const user = userEvent.setup()
    const images = makeImages(2)
    const { rerender } = render(<NoteImageGallery images={images} />)

    // Open the lightbox on the second (last) image.
    await user.click(screen.getByRole('button', { name: 'View photo2.png' }))
    expect(screen.getByText('2 / 2')).toBeInTheDocument()

    // A live SSE removal shrinks the gallery down to the first image only;
    // the lightbox should clamp to it instead of disappearing.
    rerender(<NoteImageGallery images={[images[0]]} />)

    // photo1.png now renders both as the banner tile and inside the (still
    // open) lightbox — if the lightbox had instead unmounted, only one would remain.
    expect(screen.getAllByAltText('photo1.png')).toHaveLength(2)
    expect(screen.queryByText('2 / 2')).not.toBeInTheDocument()
  })

  describe('editable mode', () => {
    it('does not render a remove button when not editable', () => {
      render(<NoteImageGallery images={[makeImage()]} />)
      expect(screen.queryByRole('button', { name: 'Remove photo.png' })).not.toBeInTheDocument()
    })

    it('calls onRemove when a tile remove button is clicked', async () => {
      const user = userEvent.setup()
      const onRemove = vi.fn()
      render(<NoteImageGallery images={[makeImage()]} editable onRemove={onRemove} />)

      await user.click(screen.getByRole('button', { name: 'Remove photo.png' }))

      expect(onRemove).toHaveBeenCalledWith(makeImage())
    })

    it('removing a tile does not also open the lightbox', async () => {
      const user = userEvent.setup()
      const onRemove = vi.fn()
      render(<NoteImageGallery images={makeImages(2)} editable onRemove={onRemove} />)

      await user.click(screen.getByRole('button', { name: 'Remove photo1.png' }))

      expect(onRemove).toHaveBeenCalledTimes(1)
      expect(screen.queryByText('1 / 2')).not.toBeInTheDocument()
    })

    it('renders a single in-progress upload as a banner tile with its progress', () => {
      render(<NoteImageGallery images={[]} editable uploads={[makeUpload({ progress: 42 })]} />)

      expect(screen.queryByTestId('note-image-grid')).not.toBeInTheDocument()
      const tile = screen.getByTestId('image-upload-tile')
      expect(tile).toHaveAttribute('data-status', 'uploading')
      expect(tile).toHaveTextContent('42%')
    })

    it('renders an upload tile alongside persisted images in the grid', () => {
      render(<NoteImageGallery images={[makeImage()]} editable uploads={[makeUpload()]} />)

      const grid = screen.getByTestId('note-image-grid')
      expect(grid.querySelectorAll('img')).toHaveLength(2)
      expect(screen.getByTestId('image-upload-tile')).toBeInTheDocument()
    })

    it('shows an error tile with retry and dismiss controls', async () => {
      const user = userEvent.setup()
      const onRetryUpload = vi.fn()
      const onDismissUpload = vi.fn()
      render(
        <NoteImageGallery
          images={[]}
          editable
          uploads={[makeUpload({ status: 'error', errorMessage: 'Upload failed' })]}
          onRetryUpload={onRetryUpload}
          onDismissUpload={onDismissUpload}
        />
      )

      expect(screen.getByTestId('image-upload-tile')).toHaveAttribute('data-status', 'error')
      expect(screen.getByText('Upload failed')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Retry uploading new.png' }))
      expect(onRetryUpload).toHaveBeenCalledWith('upload1')

      await user.click(screen.getByRole('button', { name: 'Dismiss new.png' }))
      expect(onDismissUpload).toHaveBeenCalledWith('upload1')
    })

    it('never drops an upload tile from the grid, even once the note already has 4+ images', () => {
      // A note already filling the visible grid window (4 images) plus a
      // brand-new upload: the upload must still get its own tile with
      // progress/retry feedback rather than silently falling outside the
      // visible window in favor of an older, already-settled image.
      render(<NoteImageGallery images={makeImages(4)} editable uploads={[makeUpload()]} />)

      expect(screen.getByTestId('image-upload-tile')).toBeInTheDocument()
    })

    it('opens the lightbox at the correct image index when upload tiles are present', async () => {
      const user = userEvent.setup()
      render(<NoteImageGallery images={makeImages(2)} editable uploads={[makeUpload()]} />)

      // Uploads render before images, so "photo2.png" is the last grid tile —
      // clicking it must still open the lightbox on image index 1, not the
      // tile's position in the combined upload+image grid.
      await user.click(screen.getByRole('button', { name: 'View photo2.png' }))
      expect(screen.getByText('2 / 2')).toBeInTheDocument()
    })

    it('reserves the "+N" overlay slot for a persisted image rather than an in-flight upload, when both are present', () => {
      // 4 uploads + 1 image = 5 tiles. Uploads sort first, so the naive last-
      // of-4 visible slot would be the 4th upload — hiding its progress/retry
      // controls behind the overlay, with no way to act on it. The image must
      // take that slot instead so every visible upload keeps its own status UI.
      const uploads = [
        makeUpload({ id: 'u1', filename: 'u1.png' }),
        makeUpload({ id: 'u2', filename: 'u2.png' }),
        makeUpload({ id: 'u3', filename: 'u3.png' }),
        makeUpload({ id: 'u4', filename: 'u4.png' }),
      ]
      render(<NoteImageGallery images={[makeImage()]} editable uploads={uploads} />)

      // The persisted image must actually render (as the "+N" backdrop) —
      // without the fix it's folded away entirely in favor of the 4th
      // upload occupying that slot instead, which would make this fail.
      expect(screen.getByAltText('photo.png')).toBeInTheDocument()
      expect(screen.getByText('+2')).toBeInTheDocument()

      // All three visible uploads keep their own status UI — none of them is
      // the one silently sitting behind the overlay with no progress/retry.
      const uploadTiles = screen.getAllByTestId('image-upload-tile')
      expect(uploadTiles).toHaveLength(3)
      uploadTiles.forEach(tile => expect(tile).toHaveAttribute('data-status', 'uploading'))
    })
  })
})
