import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { type ReactNode } from 'react'
import NoteModal, { ROW_REVEAL_CLASSES } from '../NoteModal'
import { ToastProvider } from '../Toast'
import { VALIDATION, type Note, type NoteItem, type NoteImage } from '@jot/shared'
import { createMockNote } from '@/utils/__tests__/test-helpers'

// Mock the API module
const {
  mockNotesUpdate,
  mockNotesCreate,
  mockCreateItem,
  mockUpdateItem,
  mockDeleteItem,
  mockReorderItems,
  mockToggleItemCompleted,
  mockImagesUpload,
  mockImagesDelete,
  dragEndRef,
} = vi.hoisted(() => ({
  // Captures the latest DndContext onDragEnd so tests can invoke a drag directly
  // with a plain { active, over, delta } payload (DOM drop events don't carry
  // dnd-kit's drag data through React's SyntheticEvent).
  dragEndRef: { current: undefined as undefined | ((event: Record<string, unknown>) => void) },
  mockNotesUpdate: vi.fn().mockResolvedValue({}),
  mockNotesCreate: vi.fn().mockResolvedValue({}),
  mockCreateItem: vi.fn().mockImplementation((_noteId, data) => Promise.resolve({ ...data })),
  mockUpdateItem: vi.fn().mockImplementation((_noteId, itemId, data) => Promise.resolve({ id: itemId, ...data })),
  mockDeleteItem: vi.fn().mockResolvedValue(undefined),
  mockReorderItems: vi.fn().mockResolvedValue(undefined),
  // By default the toggle endpoint echoes just the toggled item; individual
  // tests that need cascade override this with the full item list.
  mockToggleItemCompleted: vi.fn().mockImplementation((_noteId, itemId, completed) =>
    Promise.resolve([{ id: itemId, completed }])),
  mockImagesUpload: vi.fn().mockResolvedValue({
    id: 'uploaded1', filename: 'upload.png', content_type: 'image/png', width: 10, height: 10, created_at: '2024-01-01T00:00:00Z',
  }),
  mockImagesDelete: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/utils/api', () => ({
  notes: {
    create: mockNotesCreate,
    update: mockNotesUpdate,
    createItem: mockCreateItem,
    updateItem: mockUpdateItem,
    deleteItem: mockDeleteItem,
    reorderItems: mockReorderItems,
    toggleItemCompleted: mockToggleItemCompleted,
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
  },
  labels: {
    getAll: vi.fn().mockResolvedValue([]),
  },
  images: {
    url: (id: string) => `/api/v1/images/${id}`,
    thumbnailUrl: (id: string) => `/api/v1/images/${id}/thumbnail`,
    upload: mockImagesUpload,
    delete: mockImagesDelete,
  },
}))

// Mock @headlessui/react
vi.mock('@headlessui/react', () => {
  const DialogPanel = ({ className, children, ...rest }: { className?: string; children?: ReactNode } & Record<string, unknown>) => (
    <div className={className} data-testid="dialog-panel" {...rest}>{children}</div>
  )

  const Dialog = ({ children, open }: { children?: ReactNode; open?: boolean }) => (
    <div data-testid="dialog" style={{ display: open ? 'block' : 'none' }}>
      {open && children}
    </div>
  )

  const DialogTitle = ({ children, className }: { children?: ReactNode; className?: string }) => (
    <h2 className={className}>{children}</h2>
  )

  const DialogBackdrop = ({ className }: { className?: string }) => (
    <div className={className} data-testid="dialog-backdrop" />
  )

  return { Dialog, DialogPanel, DialogTitle, DialogBackdrop }
})

// Mock @dnd-kit components
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children?: ReactNode; onDragEnd?: (event: Record<string, unknown>) => void }) => {
    dragEndRef.current = onDragEnd;
    return <div data-testid="dnd-context">{children}</div>;
  },
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
}))

vi.mock('@dnd-kit/sortable', () => ({
  arrayMove: vi.fn((array, oldIndex, newIndex) => {
    const result = [...array]
    const [removed] = result.splice(oldIndex, 1)
    result.splice(newIndex, 0, removed)
    return result
  }),
  SortableContext: ({ children }: { children?: ReactNode }) => <div data-testid="sortable-context">{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  })),
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: vi.fn(() => ''),
    },
  },
}))


// Mock console.error to silence error logs in tests
const mockConsoleError = vi.fn()

const createMockListItems = (): NoteItem[] => [
  {
    id: 'item1',
    note_id: '1',
    text: 'First item',
    completed: false,
    position: 0,
    parent_id: null,
    assigned_to: '',
    created_at: '2023-01-01T00:00:00Z',
    updated_at: '2023-01-01T00:00:00Z',
  },
  {
    id: 'item2',
    note_id: '1',
    text: 'Second item',
    completed: true,
    position: 1,
    parent_id: null,
    assigned_to: '',
    created_at: '2023-01-01T00:00:00Z',
    updated_at: '2023-01-01T00:00:00Z',
  },
]

const renderNoteModal = (props: React.ComponentProps<typeof NoteModal>) => {
  return render(<ToastProvider><NoteModal {...props} /></ToastProvider>)
}

const defaultProps = {
  onClose: vi.fn(),
  onSave: vi.fn(),
  onRefresh: vi.fn(),
}

const mockMobileMatchMedia = () => {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }))
}

describe('NoteModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(mockConsoleError)
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('Basic Rendering', () => {
    it('renders create mode correctly (text note)', () => {
      renderNoteModal(defaultProps)

      // Text notes have no title input
      expect(screen.queryByPlaceholderText('Note title...')).not.toBeInTheDocument()
      expect(screen.getByPlaceholderText('Take a note...')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })

    it('renders create mode correctly (list note)', () => {
      renderNoteModal(defaultProps)

      // Switch to list mode
      fireEvent.click(screen.getByText('List'))

      expect(screen.getByPlaceholderText('Note title...')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })

    it('opens as a list note preset via initialType, with initialContent ignored for lists', () => {
      renderNoteModal({ ...defaultProps, initialType: 'list', initialContent: 'ignored for lists' })

      expect(screen.getByPlaceholderText('Note title...')).toBeInTheDocument()
      expect(screen.queryByText('ignored for lists')).not.toBeInTheDocument()
    })

    it('prefills a new text note from initialContent', () => {
      renderNoteModal({ ...defaultProps, initialContent: 'Shared from another app' })

      expect(screen.getByPlaceholderText('Take a note...')).toHaveValue('Shared from another app')
    })

    it('renders edit mode correctly for text note', () => {
      const note = createMockNote()
      renderNoteModal({ ...defaultProps, note })

      // Text notes have no title; content is shown in markdown preview mode
      expect(screen.getByTestId('note-content-preview')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })

    it('renders edit mode correctly for list note', () => {
      const note = createMockNote({ note_type: 'list', title: 'Test Note' })
      renderNoteModal({ ...defaultProps, note })

      expect(screen.getByDisplayValue('Test Note')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })

    it('shows note type selector only for new notes', () => {
      renderNoteModal(defaultProps)

      expect(screen.getByText('Text')).toBeInTheDocument()
      expect(screen.getByText('List')).toBeInTheDocument()
    })

    it('does not show note type selector for existing notes', () => {
      const note = createMockNote()
      renderNoteModal({ ...defaultProps, note })

      expect(screen.queryByText('Text')).not.toBeInTheDocument()
      expect(screen.queryByText('List')).not.toBeInTheDocument()
    })

    it('displays last edited time for existing notes', () => {
      const note = createMockNote({ updated_at: '2023-01-01T12:00:00Z' })
      renderNoteModal({ ...defaultProps, note })

      expect(screen.getByText(/Last edited:/)).toBeInTheDocument()
    })

    it('renders mobile app toolbar link on mobile devices', () => {
      mockMobileMatchMedia()

      const note = createMockNote()
      renderNoteModal({ ...defaultProps, note })

      const mobileLink = screen.getByTestId('note-open-mobile-app-toolbar-link')
      const href = mobileLink.getAttribute('href')
      const deepLink = new URL(href ?? '')

      expect(mobileLink).toBeInTheDocument()
      expect(deepLink.protocol).toBe('jot:')
      expect(deepLink.hostname).toBe('notes')
      expect(deepLink.pathname).toBe(`/${note.id}`)
      expect(deepLink.searchParams.get('server')).toBe(window.location.origin.toLowerCase())
    })

    it('renders mobile app toolbar link before share action on mobile devices', () => {
      mockMobileMatchMedia()

      const note = createMockNote()
      renderNoteModal({ ...defaultProps, note, onShare: vi.fn(), isOwner: true })

      const mobileLink = screen.getByTestId('note-open-mobile-app-toolbar-link')
      const shareButton = screen.getByRole('button', { name: 'Share' })
      expect(mobileLink.compareDocumentPosition(shareButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    })

    it('does not render mobile app toolbar link on non-mobile devices', () => {
      const note = createMockNote()
      renderNoteModal({ ...defaultProps, note })
      expect(screen.queryByTestId('note-open-mobile-app-toolbar-link')).not.toBeInTheDocument()
    })

    it('does not render mobile app toolbar link for new note', () => {
      renderNoteModal(defaultProps)
      expect(screen.queryByTestId('note-open-mobile-app-toolbar-link')).not.toBeInTheDocument()
    })
  })

  describe('Image gallery', () => {
    const makeImage = (overrides: Partial<NoteImage> = {}): NoteImage => ({
      id: 'img1',
      filename: 'photo.png',
      content_type: 'image/png',
      width: 800,
      height: 600,
      created_at: '2023-01-01T00:00:00Z',
      ...overrides,
    })

    it('does not render a gallery region when the note has no images', () => {
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note })

      expect(screen.queryByAltText('photo.png')).not.toBeInTheDocument()
    })

    it('renders a banner for a note with one image', () => {
      const note = createMockNote({ images: [makeImage()] })
      renderNoteModal({ ...defaultProps, note })

      expect(screen.getByAltText('photo.png')).toHaveAttribute('src', '/api/v1/images/img1/thumbnail')
    })

    it('opens the lightbox when a gallery tile is clicked', () => {
      const note = createMockNote({
        images: [makeImage(), makeImage({ id: 'img2', filename: 'photo2.png' })],
      })
      renderNoteModal({ ...defaultProps, note })

      fireEvent.click(screen.getByRole('button', { name: 'View photo.png' }))

      expect(screen.getByText('1 / 2')).toBeInTheDocument()
    })
  })

  describe('Image upload and remove', () => {
    const makeImageFile = (name = 'photo.png', type = 'image/png', size = 1024) =>
      new File([new Uint8Array(size)], name, { type })

    // Upload/delete mocks resolve via a plain promise chain with no timer of
    // their own, so vi.runAllTimersAsync() (which only ticks pending timers)
    // has nothing to advance. Flush the microtask queue directly instead.
    const flushMicrotasks = () => act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const uploadViaPicker = async (file: File) => {
      const input = screen.getByTestId('note-image-file-input') as HTMLInputElement
      fireEvent.change(input, { target: { files: [file] } })
      await flushMicrotasks()
    }

    it('does not render the add-image button for a brand-new (unsaved) note', () => {
      renderNoteModal(defaultProps)
      expect(screen.queryByRole('button', { name: 'Add image' })).not.toBeInTheDocument()
    })

    it('uploads a file selected via the toolbar picker and shows an uploading tile', async () => {
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note })

      const file = makeImageFile()
      const input = screen.getByTestId('note-image-file-input') as HTMLInputElement
      fireEvent.change(input, { target: { files: [file] } })

      expect(mockImagesUpload).toHaveBeenCalledWith('1', file, expect.any(Function))
      expect(screen.getByTestId('image-upload-tile')).toHaveAttribute('data-status', 'uploading')

      await flushMicrotasks()

      // The upload placeholder is dropped once the request resolves — the real
      // tile appears later, driven by the note_image_added SSE event.
      expect(screen.queryByTestId('image-upload-tile')).not.toBeInTheDocument()
    })

    it('rejects a non-image file with an inline error and does not upload it', async () => {
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note })

      await uploadViaPicker(new File(['x'], 'doc.pdf', { type: 'application/pdf' }))

      expect(mockImagesUpload).not.toHaveBeenCalled()
      expect(screen.getByText('Only images can be attached.')).toBeInTheDocument()
    })

    it('rejects an oversized file with an inline error and does not upload it', async () => {
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note })

      await uploadViaPicker(makeImageFile('big.png', 'image/png', 26 * 1024 * 1024))

      expect(mockImagesUpload).not.toHaveBeenCalled()
      expect(screen.getByText('Image exceeds the 25 MB limit.')).toBeInTheDocument()
    })

    it('uses the server-configured upload cap (from /config) instead of a hardcoded 25 MB', async () => {
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note, uploadMaxBytes: 10 * 1024 * 1024 })

      // 15 MB is under the hardcoded 25 MB default but over this server's
      // actual configured 10 MB cap.
      await uploadViaPicker(makeImageFile('medium.png', 'image/png', 15 * 1024 * 1024))

      expect(mockImagesUpload).not.toHaveBeenCalled()
      expect(screen.getByText('Image exceeds the 10 MB limit.')).toBeInTheDocument()
    })

    it('combines validation errors from every invalid file in one batch instead of only the last one', async () => {
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note })

      const input = screen.getByTestId('note-image-file-input') as HTMLInputElement
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'doc.pdf', { type: 'application/pdf' }), makeImageFile('big.png', 'image/png', 26 * 1024 * 1024)] },
      })
      await flushMicrotasks()

      expect(mockImagesUpload).not.toHaveBeenCalled()
      expect(screen.getByText(/Only images can be attached\./)).toBeInTheDocument()
      expect(screen.getByText(/Image exceeds the 25 MB limit\./)).toBeInTheDocument()
    })

    it('refuses to queue more uploads than the per-note image cap allows', async () => {
      const existingImages: NoteImage[] = Array.from({ length: 9 }, (_, i) => ({
        id: `img${i}`, filename: `photo${i}.png`, content_type: 'image/png', width: 10, height: 10, created_at: '2023-01-01T00:00:00Z',
      }))
      const note = createMockNote({ images: existingImages })
      renderNoteModal({ ...defaultProps, note })

      const input = screen.getByTestId('note-image-file-input') as HTMLInputElement
      fireEvent.change(input, { target: { files: [makeImageFile('a.png'), makeImageFile('b.png')] } })
      await flushMicrotasks()

      // 9 existing + 10-cap leaves exactly one free slot.
      expect(mockImagesUpload).toHaveBeenCalledTimes(1)
      expect(screen.getByText('Notes can have up to 10 images.')).toBeInTheDocument()
    })

    it('shows a retryable error tile when the upload request fails', async () => {
      mockImagesUpload.mockRejectedValueOnce(new Error('network error'))
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note })

      await uploadViaPicker(makeImageFile())

      const tile = screen.getByTestId('image-upload-tile')
      expect(tile).toHaveAttribute('data-status', 'error')

      mockImagesUpload.mockResolvedValueOnce({
        id: 'uploaded2', filename: 'photo.png', content_type: 'image/png', width: 10, height: 10, created_at: '2023-01-01T00:00:00Z',
      })
      fireEvent.click(screen.getByRole('button', { name: 'Retry uploading photo.png' }))
      await flushMicrotasks()

      expect(mockImagesUpload).toHaveBeenCalledTimes(2)
      expect(screen.queryByTestId('image-upload-tile')).not.toBeInTheDocument()
    })

    it('uploads an image dropped onto the note modal', async () => {
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note })

      const panel = screen.getByTestId('dialog-panel')
      const file = makeImageFile()
      fireEvent.drop(panel, { dataTransfer: { files: [file] } })
      await flushMicrotasks()

      expect(mockImagesUpload).toHaveBeenCalledWith('1', file, expect.any(Function))
    })

    it('shows a drop overlay while dragging a file over the modal', () => {
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note })

      const panel = screen.getByTestId('dialog-panel')
      fireEvent.dragEnter(panel, { dataTransfer: { items: [{ kind: 'file', type: 'image/png' }] } })

      expect(screen.getByTestId('note-image-drop-overlay')).toBeInTheDocument()

      fireEvent.dragLeave(panel)
      expect(screen.queryByTestId('note-image-drop-overlay')).not.toBeInTheDocument()
    })

    it('does not preventDefault on a dragover that carries no files, so native text drag-and-drop still works', () => {
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note })

      const panel = screen.getByTestId('dialog-panel')
      // fireEvent returns false only when some handler called preventDefault().
      const notPrevented = fireEvent.dragOver(panel, { dataTransfer: { types: ['text/plain'] } })
      expect(notPrevented).toBe(true)
    })

    it('uploads an image pasted onto the note modal', async () => {
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note })

      const panel = screen.getByTestId('dialog-panel')
      const file = makeImageFile()
      fireEvent.paste(panel, {
        clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
      })
      await flushMicrotasks()

      expect(mockImagesUpload).toHaveBeenCalledWith('1', file, expect.any(Function))
    })

    it('removing an image hides it immediately without deleting it right away', () => {
      const note = createMockNote({ images: [{ id: 'img1', filename: 'photo.png', content_type: 'image/png', width: 10, height: 10, created_at: '2023-01-01T00:00:00Z' }] })
      renderNoteModal({ ...defaultProps, note })

      fireEvent.click(screen.getByRole('button', { name: 'Remove photo.png' }))

      expect(screen.queryByAltText('photo.png')).not.toBeInTheDocument()
      expect(mockImagesDelete).not.toHaveBeenCalled()
      expect(screen.getByText('Image removed')).toBeInTheDocument()
    })

    it('undo restores the image and cancels the deferred delete', async () => {
      const note = createMockNote({ images: [{ id: 'img1', filename: 'photo.png', content_type: 'image/png', width: 10, height: 10, created_at: '2023-01-01T00:00:00Z' }] })
      renderNoteModal({ ...defaultProps, note })

      fireEvent.click(screen.getByRole('button', { name: 'Remove photo.png' }))
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

      expect(screen.getByAltText('photo.png')).toBeInTheDocument()

      await vi.advanceTimersByTimeAsync(15_000)
      expect(mockImagesDelete).not.toHaveBeenCalled()
    })

    it('fires the delete once the undo window elapses without an undo', async () => {
      const note = createMockNote({ images: [{ id: 'img1', filename: 'photo.png', content_type: 'image/png', width: 10, height: 10, created_at: '2023-01-01T00:00:00Z' }] })
      renderNoteModal({ ...defaultProps, note })

      fireEvent.click(screen.getByRole('button', { name: 'Remove photo.png' }))
      expect(mockImagesDelete).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockImagesDelete).toHaveBeenCalledWith('img1')
    })

    it('keeps a still-pending removal hidden with its undo bar after navigating away and back before the undo window elapses', async () => {
      const image = { id: 'img1', filename: 'photo.png', content_type: 'image/png', width: 10, height: 10, created_at: '2023-01-01T00:00:00Z' }
      const noteA = createMockNote({ id: 'noteA', images: [image] })
      const noteB = createMockNote({ id: 'noteB', images: [] })

      const { rerender } = renderNoteModal({ ...defaultProps, note: noteA })

      fireEvent.click(screen.getByRole('button', { name: 'Remove photo.png' }))
      expect(screen.queryByAltText('photo.png')).not.toBeInTheDocument()

      // Navigate to a different note, then back to noteA before the 10s undo window elapses.
      rerender(<ToastProvider><NoteModal {...defaultProps} note={noteB} /></ToastProvider>)
      rerender(<ToastProvider><NoteModal {...defaultProps} note={noteA} /></ToastProvider>)

      // The image must still be hidden with its undo bar, not silently reappear
      // only to vanish later with no explanation once the timer fires.
      expect(screen.queryByAltText('photo.png')).not.toBeInTheDocument()
      expect(screen.getByText('Image removed')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      expect(screen.getByAltText('photo.png')).toBeInTheDocument()

      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockImagesDelete).not.toHaveBeenCalled()
    })

    it('ignores a second rapid click on Retry while a retry is already in flight', async () => {
      mockImagesUpload.mockRejectedValueOnce(new Error('network error'))
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note })

      await uploadViaPicker(makeImageFile())
      expect(screen.getByTestId('image-upload-tile')).toHaveAttribute('data-status', 'error')

      let resolveRetry: (value: unknown) => void = () => {}
      mockImagesUpload.mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve }))

      const retryButton = screen.getByRole('button', { name: 'Retry uploading photo.png' })
      fireEvent.click(retryButton)
      fireEvent.click(retryButton)
      await flushMicrotasks()

      // One call for the initial (failed) upload, one for the retry — the
      // second rapid click must not fire a duplicate request.
      expect(mockImagesUpload).toHaveBeenCalledTimes(2)

      resolveRetry({
        id: 'uploaded2', filename: 'photo.png', content_type: 'image/png', width: 10, height: 10, created_at: '2023-01-01T00:00:00Z',
      })
      await flushMicrotasks()
      expect(screen.queryByTestId('image-upload-tile')).not.toBeInTheDocument()
    })

    it('shows the uploaded image immediately even when note.images is never updated (the uploader\'s own SSE echo is dropped)', async () => {
      // The note prop is never re-supplied with the new image after upload —
      // simulating the real behavior where the client that performed the
      // upload has its own note_image_added SSE event dropped (self-echo
      // suppression). The gallery must still show the real tile from a local
      // overlay, not just make the upload placeholder vanish into nothing.
      mockImagesUpload.mockResolvedValueOnce({
        id: 'newimg', filename: 'uploaded.png', content_type: 'image/png', width: 10, height: 10, created_at: '2023-01-01T00:00:00Z',
      })
      const note = createMockNote({ images: [] })
      renderNoteModal({ ...defaultProps, note })

      await uploadViaPicker(makeImageFile('uploaded.png'))

      expect(screen.queryByTestId('image-upload-tile')).not.toBeInTheDocument()
      expect(screen.getByAltText('uploaded.png')).toBeInTheDocument()
    })

    it('calls onRefresh after the deferred delete succeeds, so a stale note list is corrected even if the modal already closed', async () => {
      const note = createMockNote({ images: [{ id: 'img1', filename: 'photo.png', content_type: 'image/png', width: 10, height: 10, created_at: '2023-01-01T00:00:00Z' }] })
      const onRefresh = vi.fn()
      const { unmount } = renderNoteModal({ ...defaultProps, note, onRefresh })

      fireEvent.click(screen.getByRole('button', { name: 'Remove photo.png' }))
      onRefresh.mockClear() // drop any calls made by the removal click itself

      // The deferred-delete timer lives in a ref, not React state, precisely
      // so it keeps running after the component unmounts — unmount here so
      // this actually exercises that, instead of just the (weaker) mounted case.
      unmount()

      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockImagesDelete).toHaveBeenCalledWith('img1')
      expect(onRefresh).toHaveBeenCalled()
    })
  })

  describe('Form Validation', () => {
    it('handles title validation', async () => {
      renderNoteModal(defaultProps)

      // Switch to list mode to show title input
      fireEvent.click(screen.getByText('List'))

      const titleInput = screen.getByPlaceholderText('Note title...')

      // Test maximum length - use change event instead of typing for speed
      const longTitle = 'a'.repeat(201)
      fireEvent.change(titleInput, { target: { value: longTitle } })

      expect(screen.getByText(/Title must be 200 characters or less/)).toBeInTheDocument()
    })

    it('handles content validation', async () => {
      renderNoteModal(defaultProps)

      const contentInput = screen.getByPlaceholderText('Take a note...')

      // Test maximum length - use change event instead of typing for speed
      const longContent = 'a'.repeat(10001)
      fireEvent.change(contentInput, { target: { value: longContent } })

      expect(screen.getByText(/Content must be 10000 characters or less/)).toBeInTheDocument()
    })

    it('handles list item text validation', async () => {
      renderNoteModal(defaultProps)

      // Switch to list mode
      const listTypeButton = screen.getByText('List')
      fireEvent.click(listTypeButton)

      // Add a new item
      const addItemButton = screen.getByText('Add item')
      fireEvent.click(addItemButton)

      // Find the input field and add invalid content using change event
      const itemInput = screen.getByTestId('list-item-input')
      fireEvent.change(itemInput, { target: { value: '<script>alert("xss")</script>' } })

      expect(screen.getByText(/Item text cannot contain < or > characters/)).toBeInTheDocument()
    })

    it('validates list item length limits', async () => {
      renderNoteModal(defaultProps)

      // Switch to list mode
      const listTypeButton = screen.getByText('List')
      fireEvent.click(listTypeButton)

      // Add a new item
      const addItemButton = screen.getByText('Add item')
      fireEvent.click(addItemButton)

      // Add very long text using change event
      const itemInput = screen.getByTestId('list-item-input')
      const longText = 'a'.repeat(501)
      fireEvent.change(itemInput, { target: { value: longText } })

      expect(screen.getByText(/Item text must be 500 characters or less/)).toBeInTheDocument()
    })

    it('shows error messages for validation failures', async () => {
      renderNoteModal(defaultProps)

      // Switch to list mode to show title input
      fireEvent.click(screen.getByText('List'))

      const titleInput = screen.getByPlaceholderText('Note title...')
      const longTitle = 'a'.repeat(201)
      fireEvent.change(titleInput, { target: { value: longTitle } })

      // Should show validation error
      expect(screen.getByText(/Title must be 200 characters or less/)).toBeInTheDocument()
    })

    it('shows dismiss button for error messages', async () => {
      renderNoteModal(defaultProps)

      // Switch to list mode to show title input
      fireEvent.click(screen.getByText('List'))

      const titleInput = screen.getByPlaceholderText('Note title...')
      const longTitle = 'a'.repeat(201)
      fireEvent.change(titleInput, { target: { value: longTitle } })

      expect(screen.getByText(/Title must be 200 characters or less/)).toBeInTheDocument()

      // Should show dismiss button
      expect(screen.getByText('×')).toBeInTheDocument()
    })
  })

  describe('List Functionality', () => {
    it('switches between text and list modes', async () => {
      renderNoteModal(defaultProps)

      // Start in text mode
      expect(screen.getByPlaceholderText('Take a note...')).toBeInTheDocument()

      // Switch to list mode
      const listTypeButton = screen.getByText('List')
      fireEvent.click(listTypeButton)

      expect(screen.getByText('Add item')).toBeInTheDocument()
      expect(screen.queryByPlaceholderText('Take a note...')).not.toBeInTheDocument()

      // Switch back to text mode
      const textButton = screen.getByText('Text')
      fireEvent.click(textButton)

      expect(screen.getByPlaceholderText('Take a note...')).toBeInTheDocument()
      expect(screen.queryByText('Add item')).not.toBeInTheDocument()
    })

    it('shows list interface when in list mode', async () => {
      renderNoteModal(defaultProps)

      // Switch to list mode
      const listTypeButton = screen.getByText('List')
      fireEvent.click(listTypeButton)

      // Should show add item button
      expect(screen.getByText('Add item')).toBeInTheDocument()
    })

    it('uses multiline list textarea so long text can wrap', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))

      const listInput = screen.getByTestId('list-item-input')
      expect(listInput.tagName).toBe('TEXTAREA')
      expect(listInput).toHaveAttribute('rows', '1')
    })

    it('renders existing list items', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: createMockListItems(),
      })
      renderNoteModal({ ...defaultProps, note: listNote })

      // Should show list items
      expect(screen.getByDisplayValue('First item')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Second item')).toBeInTheDocument()
    })

    it('pressing Enter on the last uncompleted item creates a new item', async () => {
      renderNoteModal(defaultProps)

      // Switch to list mode and add an item
      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      expect(inputs).toHaveLength(1)

      // Press Enter on the only (last) item
      fireEvent.keyDown(inputs[0], { key: 'Enter', code: 'Enter' })

      // A new item should have been added
      const inputsAfter = screen.getAllByTestId('list-item-input')
      expect(inputsAfter).toHaveLength(2)
    })

    it('pressing Enter on a non-last uncompleted item inserts a new item below it', async () => {
      renderNoteModal(defaultProps)

      // Switch to list mode and add two items
      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      expect(inputs).toHaveLength(2)

      // Give the first item a value so we can identify it after insertion
      fireEvent.change(inputs[0], { target: { value: 'first' } })
      fireEvent.change(inputs[1], { target: { value: 'second' } })

      // Press Enter on the first (non-last) item
      fireEvent.keyDown(inputs[0], { key: 'Enter', code: 'Enter' })
      await vi.runAllTimersAsync()

      // Three items total
      const inputsAfter = screen.getAllByTestId('list-item-input')
      expect(inputsAfter).toHaveLength(3)

      // Original first item stays at index 0
      expect(inputsAfter[0]).toHaveValue('first')

      // New empty item is at index 1 (inserted below, not appended)
      expect(inputsAfter[1]).toHaveValue('')

      // The second item (index 2) remains unchanged
      expect(inputsAfter[2]).toHaveValue('second')

      // Focus moves to the newly inserted item
      expect(inputsAfter[1]).toHaveFocus()
    })

    it('pressing Enter on an indented item creates an equally indented item below it', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))

      // Indenting needs a preceding top-level item to nest under, so create a
      // parent first, then a second item, then indent the second under it.
      let inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[0], { target: { value: 'parent' } })
      fireEvent.keyDown(inputs[0], { key: 'Enter', code: 'Enter' })
      await vi.runAllTimersAsync()

      inputs = screen.getAllByTestId('list-item-input')
      expect(inputs).toHaveLength(2)
      fireEvent.change(inputs[1], { target: { value: 'child' } })
      fireEvent.keyDown(inputs[1], { key: 'Tab', code: 'Tab' })

      let rows = screen.getAllByTestId('list-item-row')
      expect(rows[1].style.marginLeft).toBe(`${VALIDATION.INDENT_PX_PER_LEVEL}px`)

      // Press Enter on the indented child → the new item inherits its group.
      inputs = screen.getAllByTestId('list-item-input')
      fireEvent.keyDown(inputs[1], { key: 'Enter', code: 'Enter' })
      await vi.runAllTimersAsync()

      const inputsAfter = screen.getAllByTestId('list-item-input')
      rows = screen.getAllByTestId('list-item-row')
      expect(inputsAfter).toHaveLength(3)
      expect(rows[2].style.marginLeft).toBe(`${VALIDATION.INDENT_PX_PER_LEVEL}px`)
      expect(inputsAfter[2]).toHaveFocus()
    })

    it('pressing Tab then Enter quickly keeps indentation on the new item', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))

      // Create a parent and a second item to indent under it.
      let inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[0], { target: { value: 'parent' } })
      fireEvent.keyDown(inputs[0], { key: 'Enter', code: 'Enter' })
      await vi.runAllTimersAsync()

      inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[1], { target: { value: 'child' } })

      // Simulate quick sequential key presses on the child.
      fireEvent.keyDown(inputs[1], { key: 'Tab', code: 'Tab' })
      fireEvent.keyDown(inputs[1], { key: 'Enter', code: 'Enter' })
      await vi.runAllTimersAsync()

      const rowsAfter = screen.getAllByTestId('list-item-row')
      expect(rowsAfter).toHaveLength(3)
      // The indented child and the new item below it are both one level in.
      expect(rowsAfter[1].style.marginLeft).toBe(`${VALIDATION.INDENT_PX_PER_LEVEL}px`)
      expect(rowsAfter[2].style.marginLeft).toBe(`${VALIDATION.INDENT_PX_PER_LEVEL}px`)
    })

    it('persisted update keeps inherited indent after quick Tab then Enter on existing note', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          {
            id: 'item1',
            note_id: '1',
            text: 'parent',
            completed: false,
            position: 0,
            parent_id: null,
            assigned_to: '',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
          },
          {
            id: 'item2',
            note_id: '1',
            text: 'child',
            completed: false,
            position: 1,
            parent_id: null,
            assigned_to: '',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
          },
        ],
      })

      renderNoteModal({ ...defaultProps, note: listNote })
      const inputs = screen.getAllByTestId('list-item-input')

      // Tab nests the second item under the first; Enter inserts a new item that
      // inherits that parent.
      fireEvent.keyDown(inputs[1], { key: 'Tab', code: 'Tab' })
      fireEvent.keyDown(inputs[1], { key: 'Enter', code: 'Enter' })
      await vi.runAllTimersAsync()

      expect(mockUpdateItem).toHaveBeenCalledWith('1', 'item2', expect.objectContaining({ parent_id: 'item1' }))
      expect(mockCreateItem).toHaveBeenCalledWith('1', expect.objectContaining({ text: '', parent_id: 'item1' }))
    })

    it('debounced text autosave does not overwrite quick Tab then Enter changes', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          {
            id: 'item1',
            note_id: '1',
            text: 'parent',
            completed: false,
            position: 0,
            parent_id: null,
            assigned_to: '',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
          },
          {
            id: 'item2',
            note_id: '1',
            text: '',
            completed: false,
            position: 1,
            parent_id: null,
            assigned_to: '',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
          },
        ],
      })

      renderNoteModal({ ...defaultProps, note: listNote })
      const inputs = screen.getAllByTestId('list-item-input')

      // Arms debounced text autosave on the second item.
      fireEvent.change(inputs[1], { target: { value: 'child' } })

      // Quickly apply indent and insertion before debounce flush.
      fireEvent.keyDown(inputs[1], { key: 'Tab', code: 'Tab' })
      fireEvent.keyDown(inputs[1], { key: 'Enter', code: 'Enter' })

      // Flush pending timers and async work.
      await vi.runAllTimersAsync()

      // The debounced text edit and the structural indent/insert are both
      // persisted: item2 keeps its text and is nested under item1, and the new
      // item inherits that parent.
      expect(mockUpdateItem).toHaveBeenCalledWith('1', 'item2', expect.objectContaining({ text: 'child', parent_id: 'item1' }))
      expect(mockCreateItem).toHaveBeenCalledWith('1', expect.objectContaining({ text: '', parent_id: 'item1' }))
    })

    it('queued autosave retries use latest note fields while a save is in-flight', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        title: 'Initial title',
        items: [
          {
            id: 'item1',
            note_id: '1',
            text: 'parent',
            completed: false,
            position: 0,
            parent_id: null,
            assigned_to: '',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
          },
          {
            id: 'item2',
            note_id: '1',
            text: 'child',
            completed: false,
            position: 1,
            parent_id: null,
            assigned_to: '',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
          },
        ],
      })

      let resolveFirstItem: ((value: unknown) => void) | undefined
      mockUpdateItem.mockImplementationOnce(() => new Promise(resolve => {
        resolveFirstItem = resolve
      }))

      renderNoteModal({ ...defaultProps, note: listNote })

      const listInput = screen.getByDisplayValue('child')
      const titleInput = screen.getByDisplayValue('Initial title')

      // Start first save (re-parent patch) and keep it in-flight.
      fireEvent.keyDown(listInput, { key: 'Tab', code: 'Tab' })

      // Change non-item draft fields while the save is still in-flight.
      fireEvent.change(titleInput, { target: { value: 'Updated title while saving' } })

      // Queue another save with the inserted item while still in-flight.
      fireEvent.keyDown(listInput, { key: 'Enter', code: 'Enter' })

      // Release first request, then flush queued retry.
      resolveFirstItem?.({})
      await vi.runAllTimersAsync()

      // The in-flight re-parent patch is applied, and the queued retry flushes the
      // latest title (scalar patch) and the newly inserted item.
      expect(mockUpdateItem).toHaveBeenCalledWith('1', 'item2', expect.objectContaining({ parent_id: 'item1' }))
      expect(mockNotesUpdate).toHaveBeenCalledWith('1', expect.objectContaining({ title: 'Updated title while saving' }))
      expect(mockCreateItem).toHaveBeenCalledWith('1', expect.objectContaining({ text: '', parent_id: 'item1' }))
    })

    it('pressing Enter at the start of a non-empty item inserts an empty item before it and focuses it', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[0], { target: { value: 'hello' } })

      const target = screen.getByDisplayValue('hello') as HTMLTextAreaElement
      target.setSelectionRange(0, 0)
      fireEvent.keyDown(target, { key: 'Enter', code: 'Enter' })
      await vi.runAllTimersAsync()

      const inputsAfter = screen.getAllByTestId('list-item-input')
      expect(inputsAfter).toHaveLength(2)
      // The new empty item is inserted before, the original item's text is untouched.
      expect(inputsAfter[0]).toHaveValue('')
      expect(inputsAfter[1]).toHaveValue('hello')
      // Focus moves to the newly inserted item above.
      expect(inputsAfter[0]).toHaveFocus()
    })

    it('pressing Enter at the start of an empty item still appends a new item after (no-op split)', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      expect(inputs).toHaveLength(1)
      const target = inputs[0] as HTMLTextAreaElement
      target.setSelectionRange(0, 0)
      fireEvent.keyDown(target, { key: 'Enter', code: 'Enter' })
      await vi.runAllTimersAsync()

      expect(screen.getAllByTestId('list-item-input')).toHaveLength(2)
    })

    it('pressing Enter in the middle of an item splits it into two items at the cursor', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[0], { target: { value: 'helloworld' } })

      const target = screen.getByDisplayValue('helloworld') as HTMLTextAreaElement
      target.setSelectionRange(5, 5)
      fireEvent.keyDown(target, { key: 'Enter', code: 'Enter' })
      await vi.runAllTimersAsync()

      const inputsAfter = screen.getAllByTestId('list-item-input')
      expect(inputsAfter).toHaveLength(2)
      expect(inputsAfter[0]).toHaveValue('hello')
      expect(inputsAfter[1]).toHaveValue('world')
      // Focus moves to the new (second) item, cursor at its start.
      expect(inputsAfter[1]).toHaveFocus()
      expect((inputsAfter[1] as HTMLTextAreaElement).selectionStart).toBe(0)
    })

    it('split/insert-before new items inherit the current item\'s indentation and assignee', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          {
            id: 'item1', note_id: '1', text: 'parent', completed: false, position: 0,
            parent_id: null, assigned_to: '', created_at: '2023-01-01T00:00:00Z', updated_at: '2023-01-01T00:00:00Z',
          },
          {
            id: 'item2', note_id: '1', text: 'helloworld', completed: false, position: 1,
            parent_id: 'item1', assigned_to: 'user1', created_at: '2023-01-01T00:00:00Z', updated_at: '2023-01-01T00:00:00Z',
          },
        ],
      })

      renderNoteModal({ ...defaultProps, note: listNote })
      const target = screen.getByDisplayValue('helloworld') as HTMLTextAreaElement
      target.setSelectionRange(5, 5)
      fireEvent.keyDown(target, { key: 'Enter', code: 'Enter' })
      await vi.runAllTimersAsync()

      expect(mockCreateItem).toHaveBeenCalledWith('1', expect.objectContaining({
        text: 'world',
        parent_id: 'item1',
        assigned_to: 'user1',
      }))
    })

    it('pressing Enter splits within completed items too, keeping the split-off item completed', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          {
            id: 'item1', note_id: '1', text: 'helloworld', completed: true, position: 0,
            parent_id: null, assigned_to: '', created_at: '2023-01-01T00:00:00Z', updated_at: '2023-01-01T00:00:00Z',
          },
        ],
      })

      renderNoteModal({ ...defaultProps, note: listNote })
      const target = screen.getByDisplayValue('helloworld') as HTMLTextAreaElement
      target.setSelectionRange(5, 5)
      fireEvent.keyDown(target, { key: 'Enter', code: 'Enter' })
      await vi.runAllTimersAsync()

      const inputsAfter = screen.getAllByTestId('list-item-input')
      expect(inputsAfter).toHaveLength(2)
      // Original (completed) item keeps the text before the cursor.
      expect(screen.getByDisplayValue('hello')).toBeInTheDocument()
      // The split-off remainder inherits the completed state and stays in the
      // completed section, right after the original item.
      expect(screen.getByDisplayValue('world')).toBeInTheDocument()
      expect(inputsAfter[0]).toHaveValue('hello')
      expect(inputsAfter[1]).toHaveValue('world')
      expect(mockCreateItem).toHaveBeenCalledWith('1', expect.objectContaining({
        text: 'world',
        completed: true,
      }))
    })

    it('pressing a key other than Enter on a list item does not create a new item', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      fireEvent.keyDown(inputs[0], { key: 'Escape', code: 'Escape' })

      expect(screen.getAllByTestId('list-item-input')).toHaveLength(1)
    })

    it('pressing Backspace on an empty list item deletes it', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      expect(inputs).toHaveLength(2)

      fireEvent.change(inputs[0], { target: { value: 'keep me' } })

      // Press Backspace on the second (empty) item
      fireEvent.keyDown(inputs[1], { key: 'Backspace', code: 'Backspace' })

      const inputsAfter = screen.getAllByTestId('list-item-input')
      expect(inputsAfter).toHaveLength(1)
      expect(inputsAfter[0]).toHaveValue('keep me')
    })

    it('pressing Delete on an empty list item deletes it', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      expect(inputs).toHaveLength(2)

      fireEvent.change(inputs[1], { target: { value: 'keep me' } })

      // Press Delete on the first (empty) item
      fireEvent.keyDown(inputs[0], { key: 'Delete', code: 'Delete' })

      const inputsAfter = screen.getAllByTestId('list-item-input')
      expect(inputsAfter).toHaveLength(1)
      expect(inputsAfter[0]).toHaveValue('keep me')
    })

    it('pressing Backspace on a non-empty list item does not delete it', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[0], { target: { value: 'has text' } })

      fireEvent.keyDown(inputs[0], { key: 'Backspace', code: 'Backspace' })

      expect(screen.getAllByTestId('list-item-input')).toHaveLength(1)
      expect(screen.getByDisplayValue('has text')).toBeInTheDocument()
    })

    it('pressing Delete on a non-empty list item does not delete it', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[0], { target: { value: 'has text' } })

      fireEvent.keyDown(inputs[0], { key: 'Delete', code: 'Delete' })

      expect(screen.getAllByTestId('list-item-input')).toHaveLength(1)
      expect(screen.getByDisplayValue('has text')).toBeInTheDocument()
    })

    it('pressing Backspace on the only empty list item deletes it without error', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      expect(inputs).toHaveLength(1)

      fireEvent.keyDown(inputs[0], { key: 'Backspace', code: 'Backspace' })

      expect(screen.queryAllByTestId('list-item-input')).toHaveLength(0)
    })

    it('pressing Backspace on a whitespace-only list item deletes it', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[0], { target: { value: '   ' } })

      fireEvent.keyDown(inputs[0], { key: 'Backspace', code: 'Backspace' })

      expect(screen.queryAllByTestId('list-item-input')).toHaveLength(0)
    })

    it('pressing Backspace on an empty item focuses the previous item', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[0], { target: { value: 'first' } })

      // Press Backspace on the second (empty) item
      fireEvent.keyDown(inputs[1], { key: 'Backspace', code: 'Backspace' })
      await vi.runAllTimersAsync()

      const inputsAfter = screen.getAllByTestId('list-item-input')
      expect(inputsAfter).toHaveLength(1)
      expect(inputsAfter[0]).toHaveFocus()
    })

    it('pressing Delete on an empty item focuses the next item', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[1], { target: { value: 'second' } })

      // Press Delete on the first (empty) item
      fireEvent.keyDown(inputs[0], { key: 'Delete', code: 'Delete' })
      await vi.runAllTimersAsync()

      const inputsAfter = screen.getAllByTestId('list-item-input')
      expect(inputsAfter).toHaveLength(1)
      expect(inputsAfter[0]).toHaveFocus()
    })

    it('pressing ArrowDown moves focus to the next item', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[0], { target: { value: 'first' } })
      fireEvent.change(inputs[1], { target: { value: 'second' } })

      inputs[0].focus()
      fireEvent.keyDown(inputs[0], { key: 'ArrowDown', code: 'ArrowDown' })

      expect(inputs[1]).toHaveFocus()
    })

    it('pressing ArrowUp moves focus to the previous item', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[0], { target: { value: 'first' } })
      fireEvent.change(inputs[1], { target: { value: 'second' } })

      inputs[1].focus()
      fireEvent.keyDown(inputs[1], { key: 'ArrowUp', code: 'ArrowUp' })

      expect(inputs[0]).toHaveFocus()
    })

    it('pressing ArrowUp on the first item does not change focus', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      inputs[0].focus()
      fireEvent.keyDown(inputs[0], { key: 'ArrowUp', code: 'ArrowUp' })

      expect(inputs).toHaveLength(2)
      expect(inputs[0]).toHaveFocus()
    })

    it('pressing ArrowDown on the last item does not change focus', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      inputs[1].focus()
      fireEvent.keyDown(inputs[1], { key: 'ArrowDown', code: 'ArrowDown' })

      expect(inputs).toHaveLength(2)
      expect(inputs[1]).toHaveFocus()
    })

    it('removing a list item from an existing note triggers auto-save', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          { id: 'item1', note_id: '1', text: 'First', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
          { id: 'item2', note_id: '1', text: '', completed: false, position: 1, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
        ],
      })
      mockDeleteItem.mockClear()
      renderNoteModal({ ...defaultProps, note: listNote })

      const inputs = screen.getAllByTestId('list-item-input')
      expect(inputs).toHaveLength(2)

      // Press Backspace on the empty second item
      fireEvent.keyDown(inputs[1], { key: 'Backspace', code: 'Backspace' })
      await vi.runAllTimersAsync()

      expect(screen.getAllByTestId('list-item-input')).toHaveLength(1)
      expect(mockDeleteItem).toHaveBeenCalledWith('1', 'item2')
    })

    it('removing the only list item from an existing note deletes it', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          { id: 'item1', note_id: '1', text: '', completed: false, position: 0, parent_id: null, assigned_to: '', created_at: '', updated_at: '' },
        ],
      })
      mockDeleteItem.mockClear()
      renderNoteModal({ ...defaultProps, note: listNote })

      const inputs = screen.getAllByTestId('list-item-input')
      expect(inputs).toHaveLength(1)

      // Press Backspace on the only empty item
      fireEvent.keyDown(inputs[0], { key: 'Backspace', code: 'Backspace' })
      await vi.runAllTimersAsync()

      expect(screen.queryAllByTestId('list-item-input')).toHaveLength(0)
      expect(mockDeleteItem).toHaveBeenCalledWith('1', 'item1')
    })

    it('preserves completed state when creating a new list note', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('list-item-input')
      fireEvent.change(inputs[0], { target: { value: 'First item' } })
      fireEvent.change(inputs[1], { target: { value: 'Second item' } })

      const checkboxes = screen.getAllByRole('checkbox')
      fireEvent.click(checkboxes[1])

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      await vi.runAllTimersAsync()

      expect(mockNotesCreate).toHaveBeenCalledWith(expect.objectContaining({
        items: [
          expect.objectContaining({ text: 'First item', completed: false, position: 0 }),
          expect.objectContaining({ text: 'Second item', completed: true, position: 1 }),
        ],
      }))
    })

    it('saves existing list note on close when item text changed', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          {
            id: 'item1',
            note_id: '1',
            text: 'Original item',
            completed: false,
            position: 0,
            parent_id: null,
            assigned_to: '',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
          },
        ],
      })
      const onSave = vi.fn()
      renderNoteModal({ ...defaultProps, note: listNote, onSave })

      const input = screen.getByDisplayValue('Original item')
      fireEvent.change(input, { target: { value: 'Updated item' } })

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      await vi.runAllTimersAsync()

      expect(mockUpdateItem).toHaveBeenCalledWith('1', 'item1', expect.objectContaining({ text: 'Updated item' }))
      expect(onSave).toHaveBeenCalled()
    })
  })

  describe('Grouping (parent_id)', () => {
    const item = (id: string, overrides: Partial<NoteItem> = {}): NoteItem => ({
      id,
      note_id: '1',
      text: id,
      completed: false,
      position: 0,
      parent_id: null,
      assigned_to: '',
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
      ...overrides,
    })

    it('checking an item calls the toggle endpoint, not a completed patch', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [item('item1', { text: 'Buy milk' })],
      })
      renderNoteModal({ ...defaultProps, note: listNote })

      const checkbox = screen.getAllByRole('checkbox')[0]
      fireEvent.click(checkbox)
      await vi.runAllTimersAsync()

      expect(mockToggleItemCompleted).toHaveBeenCalledWith('1', 'item1', true)
      // Completion must not be sent as a plain field patch (that would skip the cascade).
      expect(mockUpdateItem).not.toHaveBeenCalledWith('1', 'item1', expect.objectContaining({ completed: true }))
    })

    it('checking a parent cascades completion to its children from one response', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          item('parent', { text: 'Parent', position: 0 }),
          item('childA', { text: 'Child A', position: 1, parent_id: 'parent' }),
          item('childB', { text: 'Child B', position: 2, parent_id: 'parent' }),
        ],
      })
      // Server reports the whole group completed.
      mockToggleItemCompleted.mockResolvedValueOnce([
        { id: 'parent', completed: true },
        { id: 'childA', completed: true },
        { id: 'childB', completed: true },
      ])
      renderNoteModal({ ...defaultProps, note: listNote })

      // The parent is the first checkbox in the active list.
      fireEvent.click(screen.getAllByRole('checkbox')[0])
      await vi.runAllTimersAsync()

      expect(mockToggleItemCompleted).toHaveBeenCalledWith('1', 'parent', true)
      // All three rows cascade to completed → the Completed section shows count 3.
      expect(screen.getByText('Completed items (3)')).toBeInTheDocument()
      // Every checkbox now reflects the completed state.
      const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
      expect(checkboxes.every(cb => cb.checked)).toBe(true)
    })

    it('unchecking a completed child un-completes its already-completed parent', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          item('parent', { text: 'Parent', position: 0, completed: true }),
          item('childA', { text: 'Child A', position: 1, parent_id: 'parent', completed: true }),
          item('childB', { text: 'Child B', position: 2, parent_id: 'parent', completed: true }),
        ],
      })
      // Server enforces the same invariant: a parent can't stay completed once
      // one of its children is unchecked.
      mockToggleItemCompleted.mockResolvedValueOnce([
        { id: 'parent', completed: false },
        { id: 'childA', completed: false },
        { id: 'childB', completed: true },
      ])
      renderNoteModal({ ...defaultProps, note: listNote })

      // All three start completed: parent, then Child A, then Child B.
      fireEvent.click(screen.getAllByRole('checkbox')[1])
      await vi.runAllTimersAsync()

      expect(mockToggleItemCompleted).toHaveBeenCalledWith('1', 'childA', false)
      expect(screen.getByText('Completed items (1)')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Parent')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Child A')).toBeInTheDocument()
    })

    it('shows a ghost parent above a completed child whose parent is still active', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          item('parent', { text: 'Groceries', position: 0 }),
          item('childA', { text: 'Milk', position: 1, parent_id: 'parent', completed: true }),
        ],
      })
      renderNoteModal({ ...defaultProps, note: listNote })

      // The active list still shows the parent; the completed section shows the
      // child under a non-interactive ghost copy of the parent (aria-labelled).
      const ghostRow = screen.getByLabelText('Group: Groceries')
      expect(ghostRow).toBeInTheDocument()
      expect(screen.getByText('Milk')).toBeInTheDocument()

      // The ghost row must stay aligned with the parent's own indent (0 here,
      // since ghosts are only ever shown for top-level parents) rather than
      // drifting out of alignment with the other completed rows.
      expect(ghostRow.style.marginLeft).toBe('0px')
    })

    it('indenting the first item is a no-op (nothing to nest under)', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [item('item1', { text: 'only', position: 0 })],
      })
      renderNoteModal({ ...defaultProps, note: listNote })

      const input = screen.getAllByTestId('list-item-input')[0]
      fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' })
      await vi.runAllTimersAsync()

      const row = screen.getAllByTestId('list-item-row')[0]
      expect(row.style.marginLeft).toBe('0px')
      expect(mockUpdateItem).not.toHaveBeenCalled()
    })

    it('item delete button is reveal-on-hover/focus and removes the item when clicked', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          item('item1', { text: 'First', position: 0 }),
          item('item2', { text: 'Second', position: 1 }),
        ],
      })
      renderNoteModal({ ...defaultProps, note: listNote })

      const deleteButtons = screen.getAllByTestId('list-item-delete')
      expect(deleteButtons).toHaveLength(2)
      // Hidden by default; only the hovered row (desktop) or the row with a
      // focused field (works on touch too) reveals its delete button, so users
      // are less likely to delete an item they didn't intend to.
      expect(deleteButtons[0].className).toContain(ROW_REVEAL_CLASSES)
      expect(deleteButtons[0]).toHaveAttribute('aria-label', 'Remove item')

      fireEvent.click(deleteButtons[0])
      await vi.runAllTimersAsync()

      expect(screen.getAllByTestId('list-item-row')).toHaveLength(1)
      expect(screen.getByDisplayValue('Second')).toBeInTheDocument()
    })

    it('un-indenting a child promotes it to top-level via parent_id ""', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          item('parent', { text: 'Parent', position: 0 }),
          item('child', { text: 'Child', position: 1, parent_id: 'parent' }),
        ],
      })
      renderNoteModal({ ...defaultProps, note: listNote })

      // Second input is the child; Shift-Tab/left gesture maps to delta -1.
      const childInput = screen.getAllByTestId('list-item-input')[1]
      fireEvent.keyDown(childInput, { key: 'Tab', code: 'Tab', shiftKey: true })
      await vi.runAllTimersAsync()

      expect(mockUpdateItem).toHaveBeenCalledWith('1', 'child', expect.objectContaining({ parent_id: '' }))
    })

    // Issue #438 problem 1: a checked item must keep its relative slot, so it
    // unchecks back into place even after items above it are removed. The old
    // absolute-originalPosition logic dropped it at the end instead.
    it('unchecking restores an item to its relative slot after items above are removed', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          item('x0', { text: 'X0', position: 0 }),
          item('x1', { text: 'X1', position: 1 }),
          item('x2', { text: 'X2', position: 2 }),
          item('target', { text: 'TARGET', position: 3 }),
          item('x4', { text: 'X4', position: 4 }),
        ],
      })
      renderNoteModal({ ...defaultProps, note: listNote })

      const removeFirstRow = () => {
        const rows = screen.getAllByTestId('list-item-row')
        const buttons = within(rows[0]).getAllByRole('button')
        fireEvent.click(buttons[buttons.length - 1]) // trash is the last button in the row
      }

      // Check TARGET (4th active checkbox) → it moves to the completed section.
      fireEvent.click(screen.getAllByRole('checkbox')[3])
      await vi.runAllTimersAsync()
      expect(mockToggleItemCompleted).toHaveBeenCalledWith('1', 'target', true)

      // Remove the two items above TARGET (X0, X1).
      removeFirstRow()
      removeFirstRow()
      await vi.runAllTimersAsync()

      // Uncheck TARGET (now the only completed item → last checkbox).
      const checkboxes = screen.getAllByRole('checkbox')
      fireEvent.click(checkboxes[checkboxes.length - 1])
      await vi.runAllTimersAsync()
      expect(mockToggleItemCompleted).toHaveBeenCalledWith('1', 'target', false)

      // TARGET lands back between X2 and X4 — its relative slot — not at the end.
      const values = screen.getAllByTestId('list-item-input').map(el => (el as HTMLTextAreaElement).value)
      expect(values).toEqual(['X2', 'TARGET', 'X4'])
    })

    // An item dragged from one group and dropped into another must re-parent to
    // the destination group, not snap back to its original parent.
    it('dragging an item into another group re-parents it', async () => {
      const listNote = createMockNote({
        note_type: 'list',
        items: [
          item('parentA', { text: 'A', position: 0 }),
          item('childA', { text: 'a1', position: 1, parent_id: 'parentA' }),
          item('parentB', { text: 'B', position: 2 }),
          item('childB', { text: 'b1', position: 3, parent_id: 'parentB' }),
        ],
      })
      renderNoteModal({ ...defaultProps, note: listNote })

      // Drop childA onto childB (group B) — vertical drag (delta.x ~ 0), no indent.
      await act(async () => {
        dragEndRef.current?.({ active: { id: 'childA' }, over: { id: 'childB' }, delta: { x: 0, y: 0 } })
      })
      await vi.runAllTimersAsync()

      expect(mockUpdateItem).toHaveBeenCalledWith('1', 'childA', expect.objectContaining({ parent_id: 'parentB' }))
    })
  })

  describe('Text note textarea sizing', () => {
    it('sizes existing text note content after load and edit', () => {
      const note = createMockNote({ content: 'Existing long content', note_type: 'text' })
      renderNoteModal({ ...defaultProps, note })

      // Click the preview to enter edit mode
      fireEvent.click(screen.getByTestId('note-content-preview'))

      const contentInput = screen.getByDisplayValue('Existing long content') as HTMLTextAreaElement
      Object.defineProperty(contentInput, 'scrollHeight', {
        configurable: true,
        value: 500,
      })

      // Trigger resize after loading existing note content.
      fireEvent.change(contentInput, { target: { value: 'Existing long content with update' } })

      // Textarea grows to full content height — no max cap; modal scroll handles overflow
      expect(contentInput.style.height).toBe('500px')
      expect(contentInput.style.overflowY).toBe('hidden')
    })

    it('grows to full content height without a maximum cap', () => {
      renderNoteModal(defaultProps)

      const contentInput = screen.getByPlaceholderText('Take a note...') as HTMLTextAreaElement
      Object.defineProperty(contentInput, 'scrollHeight', {
        configurable: true,
        value: 500,
      })

      fireEvent.change(contentInput, { target: { value: 'Very long content' } })

      expect(contentInput.style.height).toBe('500px')
      expect(contentInput.style.overflowY).toBe('hidden')
    })

    it('uses content height when within min and max bounds', () => {
      renderNoteModal(defaultProps)

      const contentInput = screen.getByPlaceholderText('Take a note...') as HTMLTextAreaElement
      Object.defineProperty(contentInput, 'scrollHeight', {
        configurable: true,
        value: 180,
      })

      fireEvent.change(contentInput, { target: { value: 'Medium length content' } })

      expect(contentInput.style.height).toBe('180px')
      expect(contentInput.style.overflowY).toBe('hidden')
    })

    it('keeps a sensible minimum height for short content', () => {
      renderNoteModal(defaultProps)

      const contentInput = screen.getByPlaceholderText('Take a note...') as HTMLTextAreaElement
      Object.defineProperty(contentInput, 'scrollHeight', {
        configurable: true,
        value: 40,
      })

      fireEvent.change(contentInput, { target: { value: 'Short' } })

      expect(contentInput.style.height).toBe('96px')
      expect(contentInput.style.overflowY).toBe('hidden')
    })
  })


  describe('Labels on Creation', () => {
    it('shows label add button for new notes', () => {
      renderNoteModal(defaultProps)
      expect(screen.getByRole('button', { name: 'Add labels' })).toBeInTheDocument()
    })

    it('shows label add button for existing notes', () => {
      const note = createMockNote()
      renderNoteModal({ ...defaultProps, note })
      expect(screen.getByRole('button', { name: 'Add labels' })).toBeInTheDocument()
    })
  })

  describe('Dashboard update on property changes', () => {
    it('autosaves and calls onRefresh when title changes on an existing list note', async () => {
      const note = createMockNote({ note_type: 'list', title: 'Test Note' })
      const onRefresh = vi.fn()
      renderNoteModal({ ...defaultProps, onRefresh, note })

      const titleInput = screen.getByDisplayValue('Test Note')
      fireEvent.change(titleInput, { target: { value: 'New Title' } })
      await vi.runAllTimersAsync()

      expect(mockNotesUpdate).toHaveBeenCalledWith('1', expect.objectContaining({ title: 'New Title' }))
      expect(onRefresh).toHaveBeenCalled()
    })

    it('does not autosave title on new list notes (no note id)', async () => {
      renderNoteModal(defaultProps)

      // Switch to list mode to show title input
      fireEvent.click(screen.getByText('List'))

      const titleInput = screen.getByPlaceholderText('Note title...')
      fireEvent.change(titleInput, { target: { value: 'Some Title' } })
      await vi.runAllTimersAsync()

      expect(mockNotesUpdate).not.toHaveBeenCalled()
    })

    it('autosaves and calls onRefresh when content changes on an existing note', async () => {
      const note = createMockNote()
      const onRefresh = vi.fn()
      renderNoteModal({ ...defaultProps, onRefresh, note })

      // Click the preview to enter edit mode
      fireEvent.click(screen.getByTestId('note-content-preview'))

      const contentInput = screen.getByDisplayValue('Test content')
      fireEvent.change(contentInput, { target: { value: 'Updated content' } })
      await vi.runAllTimersAsync()

      expect(mockNotesUpdate).toHaveBeenCalledWith('1', expect.objectContaining({ content: 'Updated content' }))
      expect(onRefresh).toHaveBeenCalled()
    })

    it('does not autosave content on new notes (no note id)', async () => {
      renderNoteModal(defaultProps)

      const contentInput = screen.getByPlaceholderText('Take a note...')
      fireEvent.change(contentInput, { target: { value: 'Some content' } })
      await vi.runAllTimersAsync()

      expect(mockNotesUpdate).not.toHaveBeenCalled()
    })

    it('autosaves and calls onRefresh immediately when color changes on an existing note', async () => {
      const note = createMockNote()
      const onRefresh = vi.fn()
      renderNoteModal({ ...defaultProps, onRefresh, note })

      fireEvent.click(screen.getByLabelText('Select note color'))
      fireEvent.click(screen.getByTitle('Coral'))
      await vi.runAllTimersAsync()

      expect(mockNotesUpdate).toHaveBeenCalledWith('1', expect.objectContaining({ color: '#f28b82' }))
      expect(onRefresh).toHaveBeenCalled()
    })

    it('does not autosave color on new notes', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByLabelText('Select note color'))
      fireEvent.click(screen.getByTitle('Coral'))
      await vi.runAllTimersAsync()

      expect(mockNotesUpdate).not.toHaveBeenCalled()
    })

    it('title autosave debounces rapid changes and sends only the latest value', async () => {
      const note = createMockNote({ note_type: 'list', title: 'Test Note' })
      const onRefresh = vi.fn()
      renderNoteModal({ ...defaultProps, onRefresh, note })

      const titleInput = screen.getByDisplayValue('Test Note')
      fireEvent.change(titleInput, { target: { value: 'First' } })
      fireEvent.change(titleInput, { target: { value: 'Second' } })
      fireEvent.change(titleInput, { target: { value: 'Final' } })
      await vi.runAllTimersAsync()

      expect(mockNotesUpdate).toHaveBeenCalledTimes(1)
      expect(mockNotesUpdate).toHaveBeenCalledWith('1', expect.objectContaining({ title: 'Final' }))
      expect(onRefresh).toHaveBeenCalled()
    })

    it('color change cancels a pending title debounce and the save includes both changes', async () => {
      const note = createMockNote({ note_type: 'list', title: 'Test Note' })
      const onRefresh = vi.fn()
      renderNoteModal({ ...defaultProps, onRefresh, note })

      // Start a title debounce
      const titleInput = screen.getByDisplayValue('Test Note')
      fireEvent.change(titleInput, { target: { value: 'Updated Title' } })

      // Immediately click a color — should cancel the title debounce and save both
      fireEvent.click(screen.getByLabelText('Select note color'))
      fireEvent.click(screen.getByTitle('Coral'))
      await vi.runAllTimersAsync()

      // The color save should have included the updated title
      expect(mockNotesUpdate).toHaveBeenCalledWith('1', expect.objectContaining({
        title: 'Updated Title',
        color: '#f28b82',
      }))
      expect(onRefresh).toHaveBeenCalled()
    })
  })

  describe('Basic Modal Operations', () => {
    it('handles close button click', () => {
      const onClose = vi.fn()
      renderNoteModal({ ...defaultProps, onClose })

      const closeButton = screen.getByRole('button', { name: 'Close' })
      fireEvent.click(closeButton)
      expect(onClose).toHaveBeenCalled()
    })

    it('handles malformed note data', () => {
      const malformedNote = {
        id: '1',
        title: null,
        content: undefined,
        items: null,
      } as unknown as Note

      renderNoteModal({ ...defaultProps, note: malformedNote })

      // Should render without throwing errors
      expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    })

    it('handles missing note properties', () => {
      const incompleteNote = {
        id: '1',
        note_type: 'list' as const,
        title: 'Test',
      } as Note

      renderNoteModal({ ...defaultProps, note: incompleteNote })

      expect(screen.getByDisplayValue('Test')).toBeInTheDocument()
    })

    it('duplicates an existing note through the toolbar button', async () => {
      const note = createMockNote({ note_type: 'text', content: 'Original' })
      const onDuplicate = vi.fn().mockResolvedValue(undefined)
      const onClose = vi.fn()
      mockNotesUpdate.mockClear()

      renderNoteModal({ ...defaultProps, note, onDuplicate, onClose })

      // Make a pending edit, then duplicate: the edit must be flushed first.
      fireEvent.click(screen.getByTestId('note-content-preview'))
      fireEvent.change(screen.getByDisplayValue('Original'), { target: { value: 'Edited' } })

      fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
      await vi.runAllTimersAsync()

      expect(mockNotesUpdate).toHaveBeenCalledWith('1', expect.objectContaining({ content: 'Edited' }))
      expect(onDuplicate).toHaveBeenCalledWith('1')
      expect(onClose).toHaveBeenCalled()
    })
  })

  describe('markdown editing in text notes', () => {
    it('renders markdown in preview mode by default for existing notes', () => {
      const note = createMockNote({ note_type: 'text', content: '**bold**' })
      renderNoteModal({ ...defaultProps, note })
      const preview = screen.getByTestId('note-content-preview')
      expect(preview.innerHTML).toContain('<strong>bold</strong>')
    })

    it('switches to textarea when preview is clicked', () => {
      const note = createMockNote({ note_type: 'text', content: 'Hello' })
      renderNoteModal({ ...defaultProps, note })
      fireEvent.click(screen.getByTestId('note-content-preview'))
      expect(screen.getByPlaceholderText('Take a note...')).toBeInTheDocument()
    })

    it('collapses to preview on Escape', () => {
      const note = createMockNote({ note_type: 'text', content: 'Hello' })
      renderNoteModal({ ...defaultProps, note })
      fireEvent.click(screen.getByTestId('note-content-preview'))
      const textarea = screen.getByPlaceholderText('Take a note...')
      fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' })
      expect(screen.getByTestId('note-content-preview')).toBeInTheDocument()
    })

  })
})
