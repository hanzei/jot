import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter, useLocation, useNavigate, Routes, Route } from 'react-router'
import { type ReactNode } from 'react'
import Dashboard from '../Dashboard'
import type { Note, Label } from '@jot/shared'
import { notes, labels } from '@/utils/api'
import * as auth from '@/utils/auth'
import { useSSE } from '@/utils/useSSE'
import { createMockNote } from '@/utils/__tests__/test-helpers'
import { ToastProvider } from '@/components/Toast'

// Mock dependencies
vi.mock('@/utils/api', () => ({
  notes: {
    getAll: vi.fn(),
    getById: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
    restore: vi.fn(),
  },
  auth: {
    logout: vi.fn(),
  },
  labels: {
    getAll: vi.fn().mockResolvedValue([]),
  },
  users: {
    search: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@/utils/auth', () => ({
  removeUser: vi.fn(),
  getUser: vi.fn(),
  isAdmin: vi.fn(),
}))

// Mock @dnd-kit components
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children?: ReactNode; onDragEnd?: (event: Record<string, unknown>) => void }) => (
    <div
      data-testid="dnd-context"
      onDrop={(e) => {
        // Pass through the custom event data instead of the DOM event
        const evt = e as unknown as Record<string, unknown>
        if (onDragEnd && (evt['active'] || evt['over'])) {
          onDragEnd(evt)
        }
      }}
    >
      {children}
    </div>
  ),
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
  rectSortingStrategy: vi.fn(),
}))

vi.mock('@dnd-kit/modifiers', () => ({
  restrictToWindowEdges: vi.fn(),
}))

// Mock useSSE to prevent EventSource usage in jsdom environment
vi.mock('@/utils/useSSE', () => ({
  useSSE: vi.fn(),
}))

// Mock AppLayout to render children and expose props for testing
vi.mock('@/components/AppLayout', () => ({
  default: ({ title, onLogout, children, isAdmin: showAdminLink, sidebarTabs, sidebarBottomTabs, sidebarChildren, searchBar }: {
    title?: string;
    onLogout?: () => void;
    children?: ReactNode;
    isAdmin?: boolean;
    sidebarTabs?: Array<{ label: string; onClick?: () => void; isActive?: boolean; title?: string }>;
    sidebarBottomTabs?: Array<{ label: string; onClick?: () => void; isActive?: boolean; title?: string }>;
    sidebarChildren?: ReactNode;
    searchBar?: ReactNode;
  }) => (
    <div data-testid="app-layout">
      <h1>{title}</h1>
      <button onClick={onLogout} data-testid="logout-button">Logout</button>
      {showAdminLink && <div data-testid="admin-link">Admin</div>}
      <div data-testid="search-bar">{searchBar}</div>
      <div data-testid="sidebar">
        {sidebarTabs?.map(tab => (
          <button
            key={tab.label}
            onClick={tab.onClick}
            aria-label={tab.label}
            title={tab.title}
            aria-current={tab.isActive ? 'page' : undefined}
          >
            {tab.label}
          </button>
        ))}
        {sidebarChildren}
        {sidebarBottomTabs?.map(tab => (
          <button
            key={tab.label}
            onClick={tab.onClick}
            aria-label={tab.label}
            title={tab.title}
            aria-current={tab.isActive ? 'page' : undefined}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {children}
    </div>
  ),
}))

vi.mock('@/components/SortableNoteCard', () => ({
  default: ({ note, onEdit, onDelete, onShare, onRestore, onPermanentlyDelete, inBin, onRefresh }: {
    note: Note;
    onEdit?: (note: Note) => void;
    onDelete?: (id: string) => void;
    onShare?: (note: Note) => void;
    onRestore?: (id: string) => void;
    onPermanentlyDelete?: (id: string) => void;
    inBin?: boolean;
    onRefresh?: () => void;
  }) => (
    <div data-testid={`note-card-${note.id}`}>
      <h3>{note.title}</h3>
      <p>{note.content}</p>
      {inBin ? (
        <>
          <button onClick={() => onRestore?.(note.id)} data-testid={`restore-${note.id}`}>Restore</button>
          <button onClick={() => onPermanentlyDelete?.(note.id)} data-testid={`permanently-delete-${note.id}`}>Permanently Delete</button>
        </>
      ) : (
        <>
          <button onClick={() => onEdit?.(note)} data-testid={`edit-${note.id}`}>Edit</button>
          <button onClick={() => onDelete?.(note.id)} data-testid={`delete-${note.id}`}>Delete</button>
          {onShare && <button onClick={() => onShare(note)} data-testid={`share-${note.id}`}>Share</button>}
        </>
      )}
      {onRefresh && <button onClick={onRefresh} data-testid={`refresh-${note.id}`}>Refresh</button>}
    </div>
  ),
}))

vi.mock('@/components/NoteModal', () => ({
  default: ({ note, onClose, onSave, onRefresh }: { note?: Note | null; onClose?: () => void; onSave?: () => void; onRefresh?: () => void }) => (
    <div data-testid="note-modal">
      <h2>{note ? 'Edit Note' : 'New Note'}</h2>
      <button onClick={onClose} data-testid="modal-close">Close</button>
      <button onClick={onSave} data-testid="modal-save">Save</button>
      <button onClick={onRefresh} data-testid="modal-refresh">Refresh</button>
    </div>
  ),
}))

vi.mock('@/components/ShareModal', () => ({
  default: ({ note, isOpen, onClose }: { note?: Note | null; isOpen?: boolean; onClose?: () => void }) => (
    isOpen ? (
      <div data-testid="share-modal">
        <h2>Share Note: {note?.title}</h2>
        <button onClick={onClose} data-testid="share-modal-close">Close</button>
      </div>
    ) : null
  ),
}))

// Mock console.error to silence error logs in tests
const mockConsoleError = vi.fn()
vi.spyOn(console, 'error').mockImplementation(mockConsoleError)

const renderDashboard = (initialEntries = ['/']) => {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <ToastProvider>
        <Routes>
          <Route element={<Dashboard onLogout={vi.fn()} />}>
            <Route index element={null} />
            <Route path="notes/:noteId" element={null} />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  )
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.setItem('sidebar-collapsed', 'false')
    vi.mocked(auth.getUser).mockReturnValue({
      id: 'user1',
      username: 'testuser',
      first_name: '',
      last_name: '',
      role: 'user',
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
      has_profile_icon: false,
    })
    vi.mocked(auth.isAdmin).mockReturnValue(false)
    vi.mocked(notes.getAll).mockResolvedValue([])
  })

  afterEach(() => {
    mockConsoleError.mockClear()
    localStorage.clear()
  })

  describe('Basic Rendering', () => {
    it('renders dashboard with loading state initially', async () => {
      vi.mocked(notes.getAll).mockImplementation(() => new Promise(() => {})) // Never resolves
      
      renderDashboard()
      
      // Look for the loading spinner by test id
      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument()
    })

    it('renders dashboard after loading completes', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('Jot')).toBeInTheDocument()
        expect(screen.getByText('New Note')).toBeInTheDocument()
      })
    })

    it('renders navigation tabs correctly', async () => {
      renderDashboard()

      await waitFor(() => {
        expect(screen.getByText('Notes')).toBeInTheDocument()
        expect(screen.getByText('My Todo')).toBeInTheDocument()
        expect(screen.getByText('Archive')).toBeInTheDocument()
        expect(screen.getByText('Bin')).toBeInTheDocument()
      })
    })

    it('shows admin link for admin users', async () => {
      vi.mocked(auth.isAdmin).mockReturnValue(true)

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByTestId('admin-link')).toBeInTheDocument()
      })
    })

    it('does not show admin link for regular users', async () => {
      vi.mocked(auth.isAdmin).mockReturnValue(false)

      renderDashboard()

      await waitFor(() => {
        expect(screen.queryByTestId('admin-link')).not.toBeInTheDocument()
      })
    })
  })

  describe('Search Functionality', () => {
    it('renders search input', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search notes...')).toBeInTheDocument()
      })
    })

    it('handles search input changes', async () => {
      const user = userEvent.setup()
      renderDashboard()
      
      await waitFor(() => {
        const searchInput = screen.getByPlaceholderText('Search notes...')
        expect(searchInput).toBeInTheDocument()
      })
      
      const searchInput = screen.getByPlaceholderText('Search notes...')
      await user.type(searchInput, 'test query')
      
      expect(searchInput).toHaveValue('test query')
    })

    it('calls API with search query', async () => {
      const user = userEvent.setup()
      const mockGetAll = vi.mocked(notes.getAll)
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search notes...')).toBeInTheDocument()
      })
      
      const searchInput = screen.getByPlaceholderText('Search notes...')
      await user.type(searchInput, 'search term')
      
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, 'search term', false, '', false)
      })
    })

    it('handles special characters in search', async () => {
      const user = userEvent.setup()
      const mockGetAll = vi.mocked(notes.getAll)
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search notes...')).toBeInTheDocument()
      })
      
      const searchInput = screen.getByPlaceholderText('Search notes...')
      const specialChars = '<script>alert("xss")</script>'
      await user.type(searchInput, specialChars)
      
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, specialChars, false, '', false)
      })
    })

    it('handles extremely long search queries', async () => {
      const mockGetAll = vi.mocked(notes.getAll)

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search notes...')).toBeInTheDocument()
      })

      const searchInput = screen.getByPlaceholderText('Search notes...')
      const longQuery = 'a'.repeat(1000)
      // Use fireEvent.change to set the full value at once — avoids character-by-character
      // keystroke simulation timing out for very long strings
      fireEvent.change(searchInput, { target: { value: longQuery } })

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, longQuery, false, '', false)
      })
    })

    it('handles rapid search input changes', async () => {
      const user = userEvent.setup()
      const mockGetAll = vi.mocked(notes.getAll)

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search notes...')).toBeInTheDocument()
      })

      const searchInput = screen.getByPlaceholderText('Search notes...')

      // Rapid typing - use type to append each character sequentially
      await user.type(searchInput, 'abc')

      // Should have been called with the final value
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, 'abc', false, '', false)
      })
    })
  })

  describe('View Switching', () => {
    it('switches between notes and archive view', async () => {
      const user = userEvent.setup()
      const mockGetAll = vi.mocked(notes.getAll)
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('Notes')).toBeInTheDocument()
      })
      
      // Switch to archive view
      const archiveButton = screen.getByRole('button', { name: 'Archive' })
      await user.click(archiveButton)
      
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(true, '', false, '', false)
      })
    })

    it('updates URL when switching to archive view', async () => {
      const user = userEvent.setup()
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('Archive')).toBeInTheDocument()
      })
      
      const archiveButton = screen.getByRole('button', { name: 'Archive' })
      await user.click(archiveButton)
      
      // The active tab should have aria-current="page"
      await waitFor(() => {
        expect(archiveButton).toHaveAttribute('aria-current', 'page')
      })
    })

    it('loads archive view from URL parameter', async () => {
      const mockGetAll = vi.mocked(notes.getAll)
      
      renderDashboard(['/?view=archive'])
      
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(true, '', false, '', false)
      })
    })

    it('shows archive info banner in archive view', async () => {
      renderDashboard(['/?view=archive'])

      await waitFor(() => {
        expect(screen.getByText('Archived notes are hidden from the main view but kept forever.')).toBeInTheDocument()
      })
    })

    it('loads bin view from URL parameter', async () => {
      const mockNote = createMockNote({ id: 'bin-note-1', title: 'Binned Note' })
      const mockGetAll = vi.mocked(notes.getAll)
      mockGetAll.mockResolvedValue([mockNote])
      vi.mocked(notes.restore).mockResolvedValue(mockNote)
      vi.mocked(notes.delete).mockResolvedValue(undefined)

      renderDashboard(['/?view=bin'])

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, '', true, '', false)
      })

      expect(await screen.findByText('Notes in the bin are deleted after 7 days')).toBeInTheDocument()

      // Bin-specific controls should be rendered
      await waitFor(() => {
        expect(screen.getByTestId('restore-bin-note-1')).toBeInTheDocument()
        expect(screen.getByTestId('permanently-delete-bin-note-1')).toBeInTheDocument()
      })

      // Restore handler wires up correctly
      fireEvent.click(screen.getByTestId('restore-bin-note-1'))
      await waitFor(() => {
        expect(vi.mocked(notes.restore)).toHaveBeenCalledWith('bin-note-1')
      })

      mockGetAll.mockResolvedValue([mockNote])

      // Permanently delete handler wires up correctly
      fireEvent.click(screen.getByTestId('permanently-delete-bin-note-1'))
      await waitFor(() => {
        expect(vi.mocked(notes.delete)).toHaveBeenCalledWith('bin-note-1', { permanent: true })
      })
    })

    it('handles malformed URL parameters gracefully', async () => {
      const mockGetAll = vi.mocked(notes.getAll)

      renderDashboard(['/?view=invalid'])

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, '', false, '', false)
      })
    })

    it('sets sidebar tooltips for archive and bin tabs', async () => {
      renderDashboard()

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Archive' })).toHaveAttribute('title', 'Hidden notes you want to keep')
        expect(screen.getByRole('button', { name: 'Bin' })).toHaveAttribute('title', 'Deleted notes — removed after 7 days')
      })
    })
  })

  describe('Notes Display', () => {
    it('shows empty state when no notes', async () => {
      vi.mocked(notes.getAll).mockResolvedValue([])
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('No notes yet')).toBeInTheDocument()
        expect(screen.getByText('Create your first note')).toBeInTheDocument()
      })
    })

    it('shows empty archive state', async () => {
      const user = userEvent.setup()
      vi.mocked(notes.getAll).mockResolvedValue([])

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByText('Archive')).toBeInTheDocument()
      })
      await user.click(screen.getByText('Archive'))

      await waitFor(() => {
        expect(screen.getByText('No archived notes')).toBeInTheDocument()
      })
    })

    it('displays notes correctly', async () => {
      const mockNotes = [
        createMockNote({ id: '1', title: 'Note 1' }),
        createMockNote({ id: '2', title: 'Note 2' }),
      ]
      vi.mocked(notes.getAll).mockResolvedValue(mockNotes)
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByTestId('note-card-1')).toBeInTheDocument()
        expect(screen.getByTestId('note-card-2')).toBeInTheDocument()
        expect(screen.getByText('Note 1')).toBeInTheDocument()
        expect(screen.getByText('Note 2')).toBeInTheDocument()
      })
    })

    it('separates pinned and unpinned notes', async () => {
      const mockNotes = [
        createMockNote({ id: '1', title: 'Pinned Note', pinned: true }),
        createMockNote({ id: '2', title: 'Regular Note', pinned: false }),
      ]
      vi.mocked(notes.getAll).mockResolvedValue(mockNotes)
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('Pinned')).toBeInTheDocument()
        expect(screen.getByText('Other Notes')).toBeInTheDocument()
        expect(screen.getByText('Pinned Note')).toBeInTheDocument()
        expect(screen.getByText('Regular Note')).toBeInTheDocument()
      })
    })

    it('handles notes with missing or malformed data', async () => {
      const malformedNotes = [
        { id: '1', title: null, content: 'Test' } as unknown as Note,
        { id: '2', title: 'Test', content: undefined } as unknown as Note,
        createMockNote({ id: '3', created_at: 'invalid-date' }),
      ]
      vi.mocked(notes.getAll).mockResolvedValue(malformedNotes)
      
      renderDashboard()
      
      await waitFor(() => {
        // Should still render without throwing errors
        expect(screen.getByTestId('note-card-1')).toBeInTheDocument()
        expect(screen.getByTestId('note-card-2')).toBeInTheDocument()
        expect(screen.getByTestId('note-card-3')).toBeInTheDocument()
      })
    })
  })

  describe('Note Operations', () => {
    it('opens modal for creating new note', async () => {
      const user = userEvent.setup()
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('New Note')).toBeInTheDocument()
      })
      
      const newNoteButton = screen.getByText('New Note')
      await user.click(newNoteButton)
      
      await waitFor(() => {
        expect(screen.getByTestId('note-modal')).toBeInTheDocument()
        // Check for multiple "New Note" texts (button + modal)
        expect(screen.getAllByText('New Note').length).toBeGreaterThan(1)
      })
    })

    it('opens modal for editing existing note', async () => {
      const user = userEvent.setup()
      const mockNotes = [createMockNote({ id: '1', title: 'Test Note' })]
      vi.mocked(notes.getAll).mockResolvedValue(mockNotes)

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByTestId('edit-1')).toBeInTheDocument()
      })
      await user.click(screen.getByTestId('edit-1'))

      await waitFor(() => {
        expect(screen.getByTestId('note-modal')).toBeInTheDocument()
        expect(screen.getByText('Edit Note')).toBeInTheDocument()
      })
    })

    it('opens modal automatically when navigating to permalink route', async () => {
      const mockNote = createMockNote({ id: 'abc123', title: 'Permalink Note' })
      vi.mocked(notes.getById).mockResolvedValue(mockNote)

      renderDashboard(['/notes/abc123'])

      await waitFor(() => {
        expect(notes.getById).toHaveBeenCalledWith('abc123')
        expect(screen.getByTestId('note-modal')).toBeInTheDocument()
        expect(screen.getByText('Edit Note')).toBeInTheDocument()
      })
    })

    it('opens modal when navigating to a permalink route after initial render', async () => {
      const user = userEvent.setup()
      const mockNote = createMockNote({ id: 'abc123', title: 'Permalink Note' })
      vi.mocked(notes.getAll).mockResolvedValue([mockNote])
      vi.mocked(notes.getById).mockResolvedValue(mockNote)

      const NavigateToNoteButton = () => {
        const navigate = useNavigate()

        return (
          <button onClick={() => navigate('/notes/abc123')} data-testid="navigate-to-note">
            Open permalink
          </button>
        )
      }

      render(
        <MemoryRouter initialEntries={['/']}>
          <NavigateToNoteButton />
          <ToastProvider>
            <Routes>
              <Route element={<Dashboard onLogout={vi.fn()} />}>
                <Route index element={null} />
                <Route path="notes/:noteId" element={null} />
              </Route>
            </Routes>
          </ToastProvider>
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByTestId('navigate-to-note')).toBeInTheDocument()
      })

      await user.click(screen.getByTestId('navigate-to-note'))

      await waitFor(() => {
        expect(notes.getById).toHaveBeenCalledWith('abc123')
        expect(screen.getByTestId('note-modal')).toBeInTheDocument()
        expect(screen.getByText('Edit Note')).toBeInTheDocument()
      })
    })

    it('redirects to dashboard when permalink note is not found', async () => {
      vi.mocked(notes.getById).mockRejectedValue(new Error('Not found'))
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      renderDashboard(['/notes/invalid-id'])

      await waitFor(() => {
        expect(notes.getById).toHaveBeenCalledWith('invalid-id')
        expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/')
      })

      replaceStateSpy.mockRestore()
    })

    it('handles note deletion successfully', async () => {
      const user = userEvent.setup()
      const mockNotes = [createMockNote({ id: '1', title: 'Test Note' })]
      vi.mocked(notes.getAll).mockResolvedValue(mockNotes)
      vi.mocked(notes.delete).mockResolvedValue()

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByTestId('delete-1')).toBeInTheDocument()
      })
      await user.click(screen.getByTestId('delete-1'))

      await waitFor(() => {
        expect(notes.delete).toHaveBeenCalledWith('1')
      })
    })

    it('handles note deletion failure', async () => {
      const user = userEvent.setup()
      const mockNotes = [createMockNote({ id: '1', title: 'Test Note' })]
      vi.mocked(notes.getAll).mockResolvedValue(mockNotes)
      vi.mocked(notes.delete).mockRejectedValue(new Error('Delete failed'))

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByTestId('delete-1')).toBeInTheDocument()
      })
      await user.click(screen.getByTestId('delete-1'))

      await waitFor(() => {
        expect(mockConsoleError).toHaveBeenCalledWith('Failed to delete note:', expect.any(Error))
      })
    })

    it('opens share modal for note sharing', async () => {
      const user = userEvent.setup()
      const mockNotes = [createMockNote({ id: '1', title: 'Test Note' })]
      vi.mocked(notes.getAll).mockResolvedValue(mockNotes)

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByTestId('share-1')).toBeInTheDocument()
      })
      await user.click(screen.getByTestId('share-1'))

      await waitFor(() => {
        expect(screen.getByTestId('share-modal')).toBeInTheDocument()
        expect(screen.getByText('Share Note: Test Note')).toBeInTheDocument()
      })
    })

    it('refreshes notes after operations', async () => {
      const user = userEvent.setup()
      const mockNotes = [createMockNote({ id: '1', title: 'Test Note' })]
      vi.mocked(notes.getAll).mockResolvedValue(mockNotes)
      const mockGetAll = vi.mocked(notes.getAll)

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByTestId('refresh-1')).toBeInTheDocument()
      })
      await user.click(screen.getByTestId('refresh-1'))

      await waitFor(() => {
        // Should call getAll again to refresh
        expect(mockGetAll).toHaveBeenCalledTimes(2)
      })
    })
  })

  describe('Drag and Drop', () => {
    it('renders drag and drop context correctly', async () => {
      const mockNotes = [
        createMockNote({ id: '1', title: 'Note 1', pinned: false }),
        createMockNote({ id: '2', title: 'Note 2', pinned: false }),
      ]
      vi.mocked(notes.getAll).mockResolvedValue(mockNotes)
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByTestId('dnd-context')).toBeInTheDocument()
        expect(screen.getByTestId('sortable-context')).toBeInTheDocument()
        expect(screen.getByText('Note 1')).toBeInTheDocument()
        expect(screen.getByText('Note 2')).toBeInTheDocument()
      })
    })

    it('displays pinned and unpinned notes in separate sections', async () => {
      const mockNotes = [
        createMockNote({ id: '1', title: 'Pinned Note', pinned: true }),
        createMockNote({ id: '2', title: 'Regular Note', pinned: false }),
      ]
      vi.mocked(notes.getAll).mockResolvedValue(mockNotes)
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByTestId('dnd-context')).toBeInTheDocument()
        expect(screen.getByText('Pinned Note')).toBeInTheDocument()
        expect(screen.getByText('Regular Note')).toBeInTheDocument()
      })
    })


    it('handles single note display correctly', async () => {
      const mockNotes = [createMockNote({ id: '1', title: 'Note 1' })]
      vi.mocked(notes.getAll).mockResolvedValue(mockNotes)
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByTestId('dnd-context')).toBeInTheDocument()
        expect(screen.getByText('Note 1')).toBeInTheDocument()
      })
    })
  })

  describe('Authentication and Logout', () => {
    it('handles logout correctly', async () => {
      const user = userEvent.setup()
      const mockOnLogout = vi.fn()
      const mockRemoveUser = vi.mocked(auth.removeUser)

      render(
        <MemoryRouter>
          <ToastProvider>
            <Dashboard onLogout={mockOnLogout} />
          </ToastProvider>
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByTestId('logout-button')).toBeInTheDocument()
      })
      await user.click(screen.getByTestId('logout-button'))

      await waitFor(() => {
        expect(mockRemoveUser).toHaveBeenCalled()
        expect(mockOnLogout).toHaveBeenCalled()
      })
    })
  })

  describe('Error Handling', () => {
    it('handles API failures gracefully', async () => {
      vi.mocked(notes.getAll).mockRejectedValue(new Error('API Error'))
      
      renderDashboard()
      
      await waitFor(() => {
        expect(mockConsoleError).toHaveBeenCalledWith('Failed to load notes:', expect.any(Error))
      })
    })

    it('handles missing user data', async () => {
      vi.mocked(auth.getUser).mockReturnValue(null)
      
      renderDashboard()
      
      await waitFor(() => {
        // Should still render without throwing errors
        expect(screen.getByText('Jot')).toBeInTheDocument()
      })
    })

    it('handles network timeouts', async () => {
      vi.mocked(notes.getAll).mockImplementation(() => 
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 100)
        )
      )
      
      renderDashboard()
      
      await waitFor(() => {
        expect(mockConsoleError).toHaveBeenCalledWith('Failed to load notes:', expect.any(Error))
      }, { timeout: 1000 })
    })
  })

  describe('Edge Cases and Race Conditions', () => {
    it('handles rapid view switching', async () => {
      const user = userEvent.setup()
      const mockGetAll = vi.mocked(notes.getAll)
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('Archive')).toBeInTheDocument()
      })
      
      const archiveButton = screen.getByRole('button', { name: 'Archive' })
      const notesButton = screen.getByRole('button', { name: 'Notes' })
      
      // Rapid clicking
      await user.click(archiveButton)
      await user.click(notesButton)
      await user.click(archiveButton)
      
      // Should handle multiple API calls
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledTimes(4) // Initial + 3 switches
      })
    })

    it('handles concurrent note operations', async () => {
      const user = userEvent.setup()
      const mockNotes = [createMockNote({ id: '1', title: 'Test Note' })]
      vi.mocked(notes.getAll).mockResolvedValue(mockNotes)
      vi.mocked(notes.delete).mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)))
      
      renderDashboard()
      
      await waitFor(() => {
        const deleteButton = screen.getByTestId('delete-1')
        expect(deleteButton).toBeInTheDocument()
      })
      
      const deleteButton = screen.getByTestId('delete-1')
      
      // Trigger multiple delete operations
      await user.click(deleteButton)
      await user.click(deleteButton)
      
      // Should handle concurrent operations gracefully
      expect(notes.delete).toHaveBeenCalledTimes(2)
    })

    it('handles component unmounting during async operations', async () => {
      const { unmount } = renderDashboard()
      
      // Unmount while loading
      unmount()
      
      // Should not throw errors or cause memory leaks
      expect(mockConsoleError).not.toHaveBeenCalled()
    })

    it('handles modal state consistency', async () => {
      const user = userEvent.setup()
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('New Note')).toBeInTheDocument()
      })
      
      // Open modal
      const newNoteButton = screen.getByText('New Note')
      await user.click(newNoteButton)
      
      await waitFor(() => {
        expect(screen.getByTestId('note-modal')).toBeInTheDocument()
      })
      
      // Close modal
      const closeButton = screen.getByTestId('modal-close')
      await user.click(closeButton)
      
      await waitFor(() => {
        expect(screen.queryByTestId('note-modal')).not.toBeInTheDocument()
      })
    })
  })

  describe('Label Filtering', () => {
    const mockLabels: Label[] = [
      {
        id: 'label-work',
        user_id: 'user1',
        name: 'work',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
      {
        id: 'label-personal',
        user_id: 'user1',
        name: 'personal',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
    ]

    beforeEach(() => {
      vi.mocked(labels.getAll).mockResolvedValue(mockLabels)
    })

  it('renders label list in sidebar when labels exist', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <ToastProvider>
          <Dashboard onLogout={vi.fn()} />
        </ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'work' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'personal' })).toBeInTheDocument()
    })
  })

  it('does not render labels section when no labels exist', async () => {
    vi.mocked(labels.getAll).mockResolvedValue([])

    render(
      <MemoryRouter initialEntries={['/']}>
        <ToastProvider>
          <Dashboard onLogout={vi.fn()} />
        </ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('New Note')).toBeInTheDocument()
    })

    expect(screen.queryByRole('button', { name: 'work' })).not.toBeInTheDocument()
  })

  it('clicking a label calls getAll with that labelId', async () => {
    const user = userEvent.setup()
    const mockGetAll = vi.mocked(notes.getAll)

    render(
      <MemoryRouter initialEntries={['/']}>
        <ToastProvider>
          <Dashboard onLogout={vi.fn()} />
        </ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'work' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'work' }))

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })
  })

  it('clicking active label again deselects and calls getAll with empty labelId', async () => {
    const user = userEvent.setup()
    const mockGetAll = vi.mocked(notes.getAll)

    render(
      <MemoryRouter initialEntries={['/']}>
        <ToastProvider>
          <Dashboard onLogout={vi.fn()} />
        </ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'work' })).toBeInTheDocument()
    })

    // Select
    await user.click(screen.getByRole('button', { name: 'work' }))
    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })

    // Deselect
    await user.click(screen.getByRole('button', { name: 'work' }))
    await waitFor(() => {
      const calls = mockGetAll.mock.calls
      expect(calls[calls.length - 1]).toEqual([false, '', false, '', false])
    })
  })

  it('selecting a label updates search params (verified via getAll arg)', async () => {
    const LocationProbe = () => {
      const { search } = useLocation()
      return <span data-testid="location-search">{search}</span>
    }

    const user = userEvent.setup()
    const mockGetAll = vi.mocked(notes.getAll)

    render(
      <MemoryRouter initialEntries={['/']}>
        <ToastProvider>
          <Dashboard onLogout={vi.fn()} />
        </ToastProvider>
        <LocationProbe />
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'personal' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'personal' }))

    // The label id is passed to getAll only after the URL param is set and
    // the component re-renders with the new selectedLabelId from useSearchParams
    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-personal', false)
    })

    // Verify the search param was written to the URL
    await waitFor(() => {
      expect(screen.getByTestId('location-search').textContent).toContain('label=label-personal')
    })
  })

  it('deselecting a label calls getAll with empty labelId', async () => {
    const user = userEvent.setup()
    const mockGetAll = vi.mocked(notes.getAll)

    render(
      <MemoryRouter initialEntries={['/?label=label-work']}>
        <ToastProvider><Dashboard onLogout={vi.fn()} /></ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      // Initial load should use the label from URL
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'work' })).toBeInTheDocument()
    })

    // Click to deselect
    await user.click(screen.getByRole('button', { name: 'work' }))

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, '', false)
    })
  })

  it('clicking a label from archive view clears archive and fetches active notes', async () => {
    const user = userEvent.setup()
    const mockGetAll = vi.mocked(notes.getAll)

    render(
      <MemoryRouter initialEntries={['/?view=archive']}>
        <ToastProvider><Dashboard onLogout={vi.fn()} /></ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(true, '', false, '', false)
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'work' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'work' }))

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })
  })

  it('clicking a label from bin view clears bin and fetches active notes', async () => {
    const user = userEvent.setup()
    const mockGetAll = vi.mocked(notes.getAll)

    render(
      <MemoryRouter initialEntries={['/?view=bin']}>
        <ToastProvider><Dashboard onLogout={vi.fn()} /></ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', true, '', false)
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'work' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'work' }))

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })
  })

  it('clicking a label clears search query', async () => {
    const user = userEvent.setup()
    const mockGetAll = vi.mocked(notes.getAll)

    render(
      <MemoryRouter initialEntries={['/?search=hello']}>
        <ToastProvider><Dashboard onLogout={vi.fn()} /></ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, 'hello', false, '', false)
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'work' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'work' }))

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })
  })

  it('Notes tab is not highlighted when a label is selected', async () => {
    const user = userEvent.setup()

    render(
      <MemoryRouter initialEntries={['/']}>
        <ToastProvider>
          <Dashboard onLogout={vi.fn()} />
        </ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'work' })).toBeInTheDocument()
    })

    // Notes tab should initially have aria-current
    const notesButton = screen.getByRole('button', { name: 'Notes' })
    expect(notesButton).toHaveAttribute('aria-current', 'page')

    // Select a label
    await user.click(screen.getByRole('button', { name: 'work' }))

    // Notes tab should no longer have aria-current
    await waitFor(() => {
      expect(notesButton).not.toHaveAttribute('aria-current')
    })
  })

  it('clicking Notes tab while label is selected clears label and highlights Notes', async () => {
    const user = userEvent.setup()
    const mockGetAll = vi.mocked(notes.getAll)

    render(
      <MemoryRouter initialEntries={['/?label=label-work']}>
        <ToastProvider><Dashboard onLogout={vi.fn()} /></ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })

    const notesButton = screen.getByRole('button', { name: 'Notes' })
    // Notes tab should not be highlighted when label is active
    expect(notesButton).not.toHaveAttribute('aria-current')

    await user.click(notesButton)

    await waitFor(() => {
      expect(notesButton).toHaveAttribute('aria-current', 'page')
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, '', false)
    })
  })

  it('label param takes precedence over view param in URL', async () => {
    const mockGetAll = vi.mocked(notes.getAll)

    render(
      <MemoryRouter initialEntries={['/?view=archive&label=label-work']}>
        <ToastProvider><Dashboard onLogout={vi.fn()} /></ToastProvider>
      </MemoryRouter>
    )

    // Should fetch active notes with label, not archived notes
    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })

    // Notes tab should not be highlighted (label is active)
    const notesButton = screen.getByRole('button', { name: 'Notes' })
    expect(notesButton).not.toHaveAttribute('aria-current')

    // Archive tab should not be highlighted either
    const archiveButton = screen.getByRole('button', { name: 'Archive' })
    expect(archiveButton).not.toHaveAttribute('aria-current')
  })

  it('switching view clears label filter and calls getAll without labelId', async () => {
    const user = userEvent.setup()
    const mockGetAll = vi.mocked(notes.getAll)

    render(
      <MemoryRouter initialEntries={['/?label=label-work']}>
        <ToastProvider><Dashboard onLogout={vi.fn()} /></ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'work' })).toBeInTheDocument()
    })

    // Switch to archive view
    const archiveButton = screen.getByRole('button', { name: 'Archive' })
    await user.click(archiveButton)

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(true, '', false, '', false)
    })
  })
  })

  describe('Real-time label updates', () => {
    const realtimeLabel: Label = {
      id: 'label-realtime',
      user_id: 'user1',
      name: 'realtime',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    }

    it('refreshes sidebar labels when an open note refreshes locally', async () => {
      const user = userEvent.setup()

      vi.mocked(notes.getAll).mockResolvedValue([createMockNote({ id: '1', title: 'Existing Note' })])
      vi.mocked(labels.getAll)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([realtimeLabel])

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByTestId('edit-1')).toBeInTheDocument()
      })

      await user.click(screen.getByTestId('edit-1'))

      await waitFor(() => {
        expect(screen.getByTestId('note-modal')).toBeInTheDocument()
      })

      await user.click(screen.getByTestId('modal-refresh'))

      await waitFor(() => {
        expect(labels.getAll).toHaveBeenCalledTimes(2)
      })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'realtime' })).toBeInTheDocument()
      })
    })

    it('refreshes sidebar labels when SSE reports created and updated notes', async () => {
      vi.mocked(labels.getAll)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([realtimeLabel])
        .mockResolvedValueOnce([realtimeLabel])

      renderDashboard()

      await waitFor(() => {
        expect(useSSE).toHaveBeenCalled()
        expect(labels.getAll).toHaveBeenCalledTimes(1)
      })

      const sseOptions = vi.mocked(useSSE).mock.calls[0]?.[0]
      expect(sseOptions).toBeDefined()

      await act(async () => {
        sseOptions?.onEvent({
          type: 'note_created',
          note_id: 'note-1',
          note: createMockNote({ id: 'note-1', labels: [realtimeLabel] }),
          source_user_id: 'user1',
        })
      })

      await waitFor(() => {
        expect(labels.getAll).toHaveBeenCalledTimes(2)
      })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'realtime' })).toBeInTheDocument()
      })

      await act(async () => {
        sseOptions?.onEvent({
          type: 'note_updated',
          note_id: 'note-1',
          note: createMockNote({ id: 'note-1', labels: [realtimeLabel] }),
          source_user_id: 'user1',
        })
      })

      await waitFor(() => {
        expect(labels.getAll).toHaveBeenCalledTimes(3)
      })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'realtime' })).toBeInTheDocument()
      })
    })
  })

  describe('My Todo Filtering', () => {
    it('renders My Todo tab in sidebar', async () => {
      renderDashboard()

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'My Todo' })).toBeInTheDocument()
      })
    })

    it('clicking My Todo tab calls getAll with myTodo=true', async () => {
      const user = userEvent.setup()
      const mockGetAll = vi.mocked(notes.getAll)

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'My Todo' })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: 'My Todo' }))

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, '', false, '', true)
      })
    })

    it('loads My Todo view from URL parameter', async () => {
      const mockGetAll = vi.mocked(notes.getAll)

      renderDashboard(['/?view=my-todo'])

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, '', false, '', true)
      })
    })

    it('shows empty state for My Todo with no assigned notes', async () => {
      const user = userEvent.setup()
      vi.mocked(notes.getAll).mockResolvedValue([])

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'My Todo' })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: 'My Todo' }))

      await waitFor(() => {
        expect(screen.getByText('No to-do items assigned to you yet. When someone assigns a to-do item to you in a shared note, it will appear here.')).toBeInTheDocument()
      })
    })

    it('shows My Todo tab tooltip and subtitle in My Todo view', async () => {
      const user = userEvent.setup()
      vi.mocked(notes.getAll).mockResolvedValue([])

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'My Todo' })).toHaveAttribute(
          'title',
          'Notes with to-do items assigned to you'
        )
      })

      await user.click(screen.getByRole('button', { name: 'My Todo' }))

      await waitFor(() => {
        expect(screen.getByText('Showing notes that include your assigned to-do items.')).toBeInTheDocument()
      })
    })

    it('sets My Todo page title when My Todo view is active', async () => {
      renderDashboard(['/?view=my-todo'])

      await waitFor(() => {
        expect(document.title).toBe('My Todo - Jot')
      })
    })

    it('switching from My Todo to Notes clears my_todo filter', async () => {
      const user = userEvent.setup()
      const mockGetAll = vi.mocked(notes.getAll)

      renderDashboard(['/?view=my-todo'])

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, '', false, '', true)
      })

      await user.click(screen.getByRole('button', { name: 'Notes' }))

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, '', false, '', false)
      })
    })

    it('clicking a label from My Todo view clears my_todo and filters by label', async () => {
      const user = userEvent.setup()
      const mockGetAll = vi.mocked(notes.getAll)

      const mockLabels: Label[] = [
        {
          id: 'label-work',
          user_id: 'user1',
          name: 'work',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ]
      vi.mocked(labels.getAll).mockResolvedValue(mockLabels)

      renderDashboard(['/?view=my-todo'])

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, '', false, '', true)
      })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'work' })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: 'work' }))

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
      })
    })
  })
})
