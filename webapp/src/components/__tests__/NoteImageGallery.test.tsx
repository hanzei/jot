import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect } from 'vitest'
import type { NoteImage } from '@jot/shared'
import NoteImageGallery from '../NoteImageGallery'

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

describe('NoteImageGallery', () => {
  it('renders nothing when there are no images', () => {
    const { container } = render(<NoteImageGallery images={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a full-width banner for a single image', () => {
    render(<NoteImageGallery images={[makeImage()]} />)

    expect(screen.queryByTestId('note-image-grid')).not.toBeInTheDocument()
    const img = screen.getByAltText('photo.png')
    expect(img).toHaveAttribute('src', '/api/v1/images/img1')
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
})
