import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { type ReactNode } from 'react'
import Dashboard from '../Dashboard'
import { Note } from '@/types'
import { notes } from '@/utils/api'
import * as auth from '@/utils/auth'
import { createMockNote } from '@/utils/__tests__/test-helpers'

// Mock dependencies
vi.mock('@/utils/api', () => ({
  notes: {
    getAll: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
  },
}))

vi.mock('@/utils/auth', () => ({
  removeToken: vi.fn(),
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

// Mock child components
vi.mock('@/components/NavigationHeader', () => ({
  default: ({ title, onLogout, tabs, children }: {
    title?: string;
    onLogout?: () => void;
    tabs?: { label: string; element: ReactNode }[];
    children?: ReactNode;
  }) => (
    <div data-testid="navigation-header">
      <h1>{title}</h1>
      <button onClick={onLogout} data-testid="logout-button">Logout</button>
      <div data-testid="tabs">
        {tabs?.map((tab, index) => (
          <div key={index} data-testid={`tab-${tab.label.toLowerCase()}`}>
            {tab.element}
          </div>
        ))}
      </div>
      <div data-testid="search-bar">{children}</div>
    </div>
  ),
}))

vi.mock('@/components/SortableNoteCard', () => ({
  default: ({ note, onEdit, onDelete, onShare, onRefresh }: {
    note: Note;
    onEdit?: (note: Note) => void;
    onDelete?: (id: string) => void;
    onShare?: (note: Note) => void;
    onRefresh?: () => void;
  }) => (
    <div data-testid={`note-card-${note.id}`}>
      <h3>{note.title}</h3>
      <p>{note.content}</p>
      <button onClick={() => onEdit?.(note)} data-testid={`edit-${note.id}`}>Edit</button>
      <button onClick={() => onDelete?.(note.id)} data-testid={`delete-${note.id}`}>Delete</button>
      {onShare && <button onClick={() => onShare(note)} data-testid={`share-${note.id}`}>Share</button>}
      {onRefresh && <button onClick={onRefresh} data-testid={`refresh-${note.id}`}>Refresh</button>}
    </div>
  ),
}))

vi.mock('@/components/NoteModal', () => ({
  default: ({ note, onClose, onSave }: { note?: Note | null; onClose?: () => void; onSave?: () => void }) => (
    <div data-testid="note-modal">
      <h2>{note ? 'Edit Note' : 'New Note'}</h2>
      <button onClick={onClose} data-testid="modal-close">Close</button>
      <button onClick={onSave} data-testid="modal-save">Save</button>
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
      <Dashboard onLogout={vi.fn()} />
    </MemoryRouter>
  )
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(auth.getUser).mockReturnValue({
      id: 'user1',
      username: 'testuser',
      role: 'user',
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
    })
    vi.mocked(auth.isAdmin).mockReturnValue(false)
    vi.mocked(notes.getAll).mockResolvedValue([])
  })

  afterEach(() => {
    mockConsoleError.mockClear()
  })

  describe('Basic Rendering', () => {
    it('renders dashboard with loading state initially', async () => {
      vi.mocked(notes.getAll).mockImplementation(() => new Promise(() => {})) // Never resolves
      
      renderDashboard()
      
      // Look for the loading spinner by class name
      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
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
        expect(screen.getByTestId('tab-notes')).toBeInTheDocument()
        expect(screen.getByTestId('tab-archive')).toBeInTheDocument()
      })
    })

    it('shows admin tab for admin users', async () => {
      vi.mocked(auth.isAdmin).mockReturnValue(true)
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByTestId('tab-admin')).toBeInTheDocument()
      })
    })

    it('does not show admin tab for regular users', async () => {
      vi.mocked(auth.isAdmin).mockReturnValue(false)
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.queryByTestId('tab-admin')).not.toBeInTheDocument()
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
        expect(mockGetAll).toHaveBeenCalledWith(false, 'search term')
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
        expect(mockGetAll).toHaveBeenCalledWith(false, specialChars)
      })
    })

    it('handles extremely long search queries', async () => {
      const user = userEvent.setup()
      const mockGetAll = vi.mocked(notes.getAll)
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search notes...')).toBeInTheDocument()
      })
      
      const searchInput = screen.getByPlaceholderText('Search notes...')
      const longQuery = 'a'.repeat(1000)
      await user.type(searchInput, longQuery)
      
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, longQuery)
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
      
      // Rapid typing
      await user.type(searchInput, 'a')
      await user.type(searchInput, 'b')
      await user.type(searchInput, 'c')
      
      // Should call API for each character
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, 'abc')
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
      const archiveButton = screen.getByText('Archive')
      await user.click(archiveButton)
      
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(true, '')
      })
    })

    it('updates URL when switching to archive view', async () => {
      const user = userEvent.setup()
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('Archive')).toBeInTheDocument()
      })
      
      const archiveButton = screen.getByText('Archive')
      await user.click(archiveButton)
      
      // The button itself should have the active class, not the parent
      await waitFor(() => {
        expect(archiveButton).toHaveClass('bg-blue-100')
      })
    })

    it('loads archive view from URL parameter', async () => {
      const mockGetAll = vi.mocked(notes.getAll)
      
      renderDashboard(['/dashboard?view=archive'])
      
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(true, '')
      })
    })

    it('handles malformed URL parameters gracefully', async () => {
      const mockGetAll = vi.mocked(notes.getAll)
      
      renderDashboard(['/dashboard?view=invalid'])
      
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, '')
      })
    })
  })

  describe('Notes Display', () => {
    it('shows empty state when no notes', async () => {
      vi.mocked(notes.getAll).mockResolvedValue([])
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('No notes yet')).toBeInTheDocument()
        expect(screen.getByText('Click "New Note" to create your first note')).toBeInTheDocument()
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
      const mockRemoveToken = vi.mocked(auth.removeToken)

      render(
        <MemoryRouter>
          <Dashboard onLogout={mockOnLogout} />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(screen.getByTestId('logout-button')).toBeInTheDocument()
      })
      await user.click(screen.getByTestId('logout-button'))

      await waitFor(() => {
        expect(mockRemoveToken).toHaveBeenCalled()
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
      
      const archiveButton = screen.getByText('Archive')
      const notesButton = screen.getByText('Notes')
      
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
})