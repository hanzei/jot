import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter, useLocation, useNavigate, Routes, Route } from 'react-router'
import { type ReactNode, useCallback, useState, useEffect } from 'react'
import React from 'react'
import Dashboard from '../Dashboard'
import type { AuthResponse, Note, Label, NoteSort, UserSettings } from '@jot/shared'
import { notes, labels, users } from '@/utils/api'
import * as auth from '@/utils/auth'
import { useSSE } from '@/utils/useSSE'
import { useAuthenticatedLayout } from '@/components/AuthenticatedLayout'
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
    create: vi.fn(),
    getCounts: vi.fn().mockResolvedValue({}),
    rename: vi.fn(),
    delete: vi.fn(),
  },
  users: {
    search: vi.fn().mockResolvedValue([]),
    updateMe: vi.fn().mockResolvedValue({
      settings: {
        user_id: 'user1',
        language: 'system',
        theme: 'system',
        note_sort: 'manual',
        updated_at: '2023-01-01T00:00:00Z',
      },
    }),
  },
}))

vi.mock('@/utils/auth', () => ({
  removeUser: vi.fn(),
  getUser: vi.fn(),
  getSettings: vi.fn(),
  setSettings: vi.fn(),
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

vi.mock('@/components/AuthenticatedLayout', () => ({
  useAuthenticatedLayout: vi.fn(),
}))

// Captures the search bar content injected by Dashboard via setSearchBar
// so tests can query search bar elements.
const captureSearchBarRef = React.createRef<((content: ReactNode) => void)>() as React.MutableRefObject<(content: ReactNode) => void>
captureSearchBarRef.current = () => {}
const SearchBarCapture = ({ children }: { children: ReactNode }) => {
  const [searchBar, setSearchBar] = React.useState<ReactNode>(null)
  React.useEffect(() => {
    captureSearchBarRef.current = setSearchBar
  }, [setSearchBar])
  return (
    <>
      {children}
      <div data-testid="search-bar">{searchBar}</div>
    </>
  )
}

vi.mock('@/components/SortableNoteCard', () => ({
  default: ({ note, onEdit, onDelete, onShare, onRestore, onPermanentlyDelete, disabled, inBin, onRefresh }: {
    note: Note;
    onEdit?: (note: Note) => void;
    onDelete?: (id: string) => void;
    onShare?: (note: Note) => void;
    onRestore?: (id: string) => void;
    onPermanentlyDelete?: (id: string) => void;
    disabled?: boolean;
    inBin?: boolean;
    onRefresh?: () => void;
  }) => (
    <div data-testid={`note-card-${note.id}`} data-disabled={disabled ? 'true' : 'false'}>
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
        <SearchBarCapture>
          <Routes>
            <Route element={<Dashboard />}>
              <Route index element={null} />
              <Route path="notes/:noteId" element={null} />
            </Route>
          </Routes>
        </SearchBarCapture>
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
    vi.mocked(auth.getSettings).mockReturnValue({
      user_id: 'user1',
      language: 'system',
      theme: 'system',
      note_sort: 'manual',
      updated_at: '2023-01-01T00:00:00Z',
    })
    vi.mocked(notes.getAll).mockResolvedValue([])
    vi.mocked(useAuthenticatedLayout).mockImplementation(() => {
      const [labelsList, setLabelsList] = useState<Label[]>([])

      const loadLabels = useCallback(async ({ preserveOnError = false }: { preserveOnError?: boolean } = {}) => {
        try {
          const nextLabels = await labels.getAll()
          setLabelsList(nextLabels)
          return nextLabels
        } catch {
          if (!preserveOnError) {
            setLabelsList([])
          }
          return null
        }
      }, [])

      const loadLabelCounts = useCallback(async ({ preserveOnError = false }: { preserveOnError?: boolean } = {}) => {
        try {
          const counts = await labels.getCounts()
          return counts
        } catch {
          if (!preserveOnError) {
            return null
          }
          return null
        }
      }, [])

      useEffect(() => {
        void Promise.all([loadLabels(), loadLabelCounts()])
      }, [loadLabels, loadLabelCounts])

      return {
        labels: labelsList,
        labelCounts: null,
        loadLabels,
        loadLabelCounts,
        handleCreateLabel: vi.fn().mockResolvedValue(true),
        handleRenameLabel: vi.fn().mockResolvedValue(true),
        handleDeleteLabel: vi.fn().mockResolvedValue(true),
        registerLabelCallbacks: vi.fn(),
        setSearchBar: (content: ReactNode) => captureSearchBarRef.current(content),
      }
    })
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
        expect(screen.getByText('New Note')).toBeInTheDocument()
      })
    })

  })

  describe('Search Functionality', () => {
    it('focuses search when Meta+F is pressed', async () => {
      renderDashboard()

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search notes...')).toBeInTheDocument()
      })

      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      expect(screen.getByPlaceholderText('Search notes...')).toHaveFocus()
    })

    it('renders search input', async () => {
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search notes...')).toBeInTheDocument()
      })
    })

    it('renders keyboard shortcut hint in dashboard search input', async () => {
      renderDashboard()

      await waitFor(() => {
        expect(screen.getByTestId('search-shortcut-hint')).toHaveTextContent('Ctrl + F')
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

    it('clears search input when escape is pressed', async () => {
      const mockGetAll = vi.mocked(notes.getAll)

      renderDashboard(['/?search=escape%20query'])

      await waitFor(() => {
        const searchInput = screen.getByPlaceholderText('Search notes...')
        expect(searchInput).toBeInTheDocument()
        expect(searchInput).toHaveValue('escape query')
        expect(mockGetAll).toHaveBeenCalledWith(false, 'escape query', false, '', false)
      })

      const searchInput = screen.getByPlaceholderText('Search notes...')
      fireEvent.keyDown(searchInput, { key: 'Escape', code: 'Escape' })

      await waitFor(() => {
        expect(searchInput).toHaveValue('')
        expect(mockGetAll).toHaveBeenLastCalledWith(false, '', false, '', false)
      })
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

  describe('Sorting', () => {
    it('renders the sort control with the saved preference', async () => {
      vi.mocked(auth.getSettings).mockReturnValue({
        user_id: 'user1',
        language: 'system',
        theme: 'system',
        note_sort: 'unsupported' as unknown as NoteSort,
        updated_at: '2023-01-01T00:00:00Z',
      })

      renderDashboard()

      await waitFor(() => {
        expect(screen.getByTestId('dashboard-sort-select')).toHaveValue('manual')
      })
    })

    it('sorts pinned and unpinned notes by last modified within their groups', async () => {
      vi.mocked(auth.getSettings).mockReturnValue({
        user_id: 'user1',
        language: 'system',
        theme: 'system',
        note_sort: 'updated_at',
        updated_at: '2023-01-01T00:00:00Z',
      })
      vi.mocked(notes.getAll).mockResolvedValue([
        createMockNote({ id: 'unpinned-old', title: 'Older unpinned', pinned: false, updated_at: '2024-01-01T00:00:00Z' }),
        createMockNote({ id: 'pinned-old', title: 'Older pinned', pinned: true, updated_at: '2024-01-01T00:00:00Z' }),
        createMockNote({ id: 'unpinned-new', title: 'Newer unpinned', pinned: false, updated_at: '2024-01-03T00:00:00Z' }),
        createMockNote({ id: 'pinned-new', title: 'Newer pinned', pinned: true, updated_at: '2024-01-03T00:00:00Z' }),
      ])

      renderDashboard()

      await waitFor(() => {
        const renderedOrder = screen.getAllByTestId(/^note-card-/).map(card => card.getAttribute('data-testid'))
        expect(renderedOrder).toEqual([
          'note-card-pinned-new',
          'note-card-pinned-old',
          'note-card-unpinned-new',
          'note-card-unpinned-old',
        ])
      })
    })

    it('persists sort changes and disables manual reordering for non-manual sorts', async () => {
      const user = userEvent.setup()
      vi.mocked(notes.getAll).mockResolvedValue([
        createMockNote({ id: '1', title: 'A note' }),
        createMockNote({ id: '2', title: 'B note' }),
      ])
      vi.mocked(users.updateMe).mockResolvedValue({
        user: {
          id: 'user1',
          username: 'testuser',
          first_name: '',
          last_name: '',
          role: 'user',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
          has_profile_icon: false,
        },
        settings: {
          user_id: 'user1',
          language: 'system',
          theme: 'system',
          note_sort: 'updated_at',
          updated_at: '2023-01-01T00:00:00Z',
        },
      })

      renderDashboard()

      const sortSelect = await screen.findByTestId('dashboard-sort-select')
      await user.selectOptions(sortSelect, 'updated_at')

      await waitFor(() => {
        expect(users.updateMe).toHaveBeenCalledWith({ note_sort: 'updated_at' })
        expect(screen.getByTestId('manual-reorder-disabled-notice')).toBeInTheDocument()
        expect(screen.getByTestId('note-card-1')).toHaveAttribute('data-disabled', 'true')
      })

      expect(auth.setSettings).toHaveBeenCalledWith(expect.objectContaining({ note_sort: 'updated_at' }))
    })

    it('rolls back sort changes when persistence fails', async () => {
      const user = userEvent.setup()
      let currentSettings: UserSettings = {
        user_id: 'user1',
        language: 'system',
        theme: 'system',
        note_sort: 'manual',
        updated_at: '2023-01-01T00:00:00Z',
      }
      vi.mocked(auth.getSettings).mockImplementation(() => currentSettings)
      vi.mocked(auth.setSettings).mockImplementation((settings) => {
        currentSettings = settings
      })
      vi.mocked(notes.getAll).mockResolvedValue([
        createMockNote({ id: '1', title: 'A note' }),
        createMockNote({ id: '2', title: 'B note' }),
      ])
      vi.mocked(users.updateMe).mockRejectedValueOnce(new Error('save failed'))

      renderDashboard()

      const sortSelect = await screen.findByTestId('dashboard-sort-select')
      await user.selectOptions(sortSelect, 'updated_at')

      await waitFor(() => {
        expect(users.updateMe).toHaveBeenCalledWith({ note_sort: 'updated_at' })
        expect(sortSelect).toHaveValue('manual')
        expect(screen.queryByTestId('manual-reorder-disabled-notice')).not.toBeInTheDocument()
        expect(screen.getByTestId('note-card-1')).toHaveAttribute('data-disabled', 'false')
      })

      expect(currentSettings.note_sort).toBe('manual')
      expect(auth.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ note_sort: 'manual' }))
    })

    it('keeps the final sort when an earlier persistence request fails later', async () => {
      const user = userEvent.setup()
      let currentSettings: UserSettings = {
        user_id: 'user1',
        language: 'system',
        theme: 'system',
        note_sort: 'manual',
        updated_at: '2023-01-01T00:00:00Z',
      }
      vi.mocked(auth.getSettings).mockImplementation(() => currentSettings)
      vi.mocked(auth.setSettings).mockImplementation((settings) => {
        currentSettings = settings
      })
      vi.mocked(notes.getAll).mockResolvedValue([
        createMockNote({ id: '1', title: 'A note' }),
        createMockNote({ id: '2', title: 'B note' }),
      ])

      let rejectFirstRequest: ((reason?: unknown) => void) | undefined
      const firstRequest = new Promise<AuthResponse>((_, reject) => {
        rejectFirstRequest = reject
      })

      vi.mocked(users.updateMe)
        .mockReturnValueOnce(firstRequest)
        .mockResolvedValueOnce({
          user: {
            id: 'user1',
            username: 'testuser',
            first_name: '',
            last_name: '',
            role: 'user',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
            has_profile_icon: false,
          },
          settings: {
            user_id: 'user1',
            language: 'system',
            theme: 'system',
            note_sort: 'created_at',
            updated_at: '2023-01-01T00:00:00Z',
          },
        })

      renderDashboard()

      const sortSelect = await screen.findByTestId('dashboard-sort-select')
      await user.selectOptions(sortSelect, 'updated_at')
      await user.selectOptions(sortSelect, 'created_at')

      await waitFor(() => {
        expect(sortSelect).toHaveValue('created_at')
        expect(screen.getByTestId('manual-reorder-disabled-notice')).toBeInTheDocument()
      })

      rejectFirstRequest?.(new Error('stale failure'))

      await waitFor(() => {
        expect(sortSelect).toHaveValue('created_at')
        expect(screen.getByTestId('note-card-1')).toHaveAttribute('data-disabled', 'true')
      })

      expect(currentSettings.note_sort).toBe('created_at')
      expect(auth.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ note_sort: 'created_at' }))
    })
  })

  describe('View Switching', () => {
    it('switches between notes and archive view', async () => {
      const mockGetAll = vi.mocked(notes.getAll)

      renderDashboard(['/?view=archive'])

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(true, '', false, '', false)
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

  })

  describe('Notes Display', () => {
    it('shows empty state when no notes', async () => {
      vi.mocked(notes.getAll).mockResolvedValue([])
      
      renderDashboard()
      
      await waitFor(() => {
        expect(screen.getByText('No notes yet')).toBeInTheDocument()
        expect(screen.getByText('Click "New Note" to create your first note')).toBeInTheDocument()
        expect(screen.getByText('Create your first note')).toBeInTheDocument()
        expect(screen.getByTestId('dashboard-empty-state')).toBeInTheDocument()
      })
    })

    it('shows empty archive state', async () => {
      vi.mocked(notes.getAll).mockResolvedValue([])

      renderDashboard(['/?view=archive'])

      await waitFor(() => {
        expect(screen.getByText('No archived notes')).toBeInTheDocument()
        expect(screen.getByText('Notes you archive will appear here.')).toBeInTheDocument()
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
              <Route element={<Dashboard />}>
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

    it('clears the current modal before loading a different permalink note', async () => {
      const user = userEvent.setup()
      const currentNote = createMockNote({ id: 'abc123', title: 'Current Note' })
      let resolveNextNote: ((note: Note) => void) | undefined

      vi.mocked(notes.getById)
        .mockResolvedValueOnce(currentNote)
        .mockImplementationOnce(() => new Promise<Note>((resolve) => {
          resolveNextNote = resolve
        }))

      const NavigateToNextNoteButton = () => {
        const navigate = useNavigate()

        return (
          <button onClick={() => navigate('/notes/next-note')} data-testid="navigate-to-next-note">
            Open next permalink
          </button>
        )
      }

      render(
        <MemoryRouter initialEntries={['/notes/abc123']}>
          <NavigateToNextNoteButton />
          <ToastProvider>
            <Routes>
              <Route element={<Dashboard />}>
                <Route index element={null} />
                <Route path="notes/:noteId" element={null} />
              </Route>
            </Routes>
          </ToastProvider>
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(notes.getById).toHaveBeenCalledWith('abc123')
        expect(screen.getByTestId('note-modal')).toBeInTheDocument()
      })

      await user.click(screen.getByTestId('navigate-to-next-note'))

      await waitFor(() => {
        expect(notes.getById).toHaveBeenNthCalledWith(2, 'next-note')
      })

      await waitFor(() => {
        expect(screen.queryByTestId('note-modal')).not.toBeInTheDocument()
      })

      await act(async () => {
        resolveNextNote?.(createMockNote({ id: 'next-note', title: 'Next Note' }))
      })

      await waitFor(() => {
        expect(screen.getByTestId('note-modal')).toBeInTheDocument()
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
      const initialCalls = mockGetAll.mock.calls.length
      await user.click(screen.getByTestId('refresh-1'))

      await waitFor(() => {
        // Refresh should trigger at least one additional notes fetch.
        expect(mockGetAll.mock.calls.length).toBeGreaterThanOrEqual(initialCalls + 1)
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

  describe('Error Handling', () => {
    it('handles API failures gracefully', async () => {
      vi.mocked(notes.getAll).mockRejectedValue(new Error('API Error'))
      
      renderDashboard()
      
      await waitFor(() => {
        expect(mockConsoleError).toHaveBeenCalledWith('Failed to load notes:', expect.any(Error))
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

  it('fetches notes filtered by label when URL has label param', async () => {
    const mockGetAll = vi.mocked(notes.getAll)

    renderDashboard(['/?label=label-work'])

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })
  })

  it('fetches active notes when URL label param is removed', async () => {
    const user = userEvent.setup()
    const mockGetAll = vi.mocked(notes.getAll)

    const NavHelper = () => {
      const navigate = useNavigate()
      return <button data-testid="go-home" onClick={() => navigate('/')}>home</button>
    }

    render(
      <MemoryRouter initialEntries={['/?label=label-work']}>
        <NavHelper />
        <ToastProvider>
          <SearchBarCapture>
            <Routes>
              <Route element={<Dashboard />}>
                <Route index element={null} />
                <Route path="notes/:noteId" element={null} />
              </Route>
            </Routes>
          </SearchBarCapture>
        </ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })

    await user.click(screen.getByTestId('go-home'))

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, '', false)
    })
  })

  it('clears label filter and fetches archived notes when URL switches to archive view', async () => {
    const user = userEvent.setup()
    const mockGetAll = vi.mocked(notes.getAll)

    const NavHelper = () => {
      const navigate = useNavigate()
      return <button data-testid="go-archive" onClick={() => navigate('/?view=archive')}>archive</button>
    }

    render(
      <MemoryRouter initialEntries={['/?label=label-work']}>
        <NavHelper />
        <ToastProvider>
          <SearchBarCapture>
            <Routes>
              <Route element={<Dashboard />}>
                <Route index element={null} />
                <Route path="notes/:noteId" element={null} />
              </Route>
            </Routes>
          </SearchBarCapture>
        </ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })

    await user.click(screen.getByTestId('go-archive'))

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(true, '', false, '', false)
    })
  })

  it('sets label-specific page title when a label filter is selected', async () => {
    renderDashboard(['/?label=label-personal'])

    await waitFor(() => {
      expect(document.title).toBe('personal - Jot')
    })
  })

  it('fetches notes with label from archive URL (label param overrides view)', async () => {
    const mockGetAll = vi.mocked(notes.getAll)

    renderDashboard(['/?view=archive&label=label-work'])

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })
  })

  it('fetches notes with label from bin URL (label param overrides view)', async () => {
    const mockGetAll = vi.mocked(notes.getAll)

    renderDashboard(['/?view=bin&label=label-work'])

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-work', false)
    })
  })

  it('shows label-specific empty state and hides create-first-note CTA when label has no notes', async () => {
    vi.mocked(notes.getAll).mockResolvedValue([])

    render(
      <MemoryRouter initialEntries={['/?label=label-work']}>
        <ToastProvider><Routes><Route element={<Dashboard />}><Route index element={null} /></Route></Routes></ToastProvider>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-empty-state')).toBeInTheDocument()
      expect(screen.getByText('No notes for this label')).toBeInTheDocument()
      expect(screen.getByText('Notes tagged with this label will appear here.')).toBeInTheDocument()
      expect(screen.queryByText('Create your first note')).not.toBeInTheDocument()
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
    })

    it('refreshes labels when SSE reports created and updated notes', async () => {
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
          source_user_id: 'user1',
          data: { note_id: 'note-1', note: createMockNote({ id: 'note-1', labels: [realtimeLabel] }) },
        })
      })

      await waitFor(() => {
        expect(labels.getAll).toHaveBeenCalledTimes(2)
      })

      await act(async () => {
        sseOptions?.onEvent({
          type: 'note_updated',
          source_user_id: 'user1',
          data: { note_id: 'note-1', note: createMockNote({ id: 'note-1', labels: [realtimeLabel] }) },
        })
      })

      await waitFor(() => {
        expect(labels.getAll).toHaveBeenCalledTimes(3)
      })
    })

    it('refreshes labels and counts when SSE reports labels_changed', async () => {
      vi.mocked(labels.getAll)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([realtimeLabel])
      vi.mocked(labels.getCounts)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ 'label-realtime': 1 })

      renderDashboard()

      await waitFor(() => {
        expect(useSSE).toHaveBeenCalled()
        expect(labels.getAll).toHaveBeenCalledTimes(1)
        expect(labels.getCounts).toHaveBeenCalledTimes(1)
      })

      const sseOptions = vi.mocked(useSSE).mock.calls[0]?.[0]
      expect(sseOptions).toBeDefined()

      await act(async () => {
        sseOptions?.onEvent({
          type: 'labels_changed',
          source_user_id: 'user1',
          data: { label: realtimeLabel },
        })
      })

      await waitFor(() => {
        expect(labels.getAll).toHaveBeenCalledTimes(2)
        expect(labels.getCounts).toHaveBeenCalledTimes(2)
      })
    })

    it('clears stale selected label from URL after labels_changed removes it', async () => {
      const mockGetAll = vi.mocked(notes.getAll)
      vi.mocked(labels.getAll)
        .mockResolvedValueOnce([realtimeLabel])
        .mockResolvedValueOnce([])
      vi.mocked(labels.getCounts)
        .mockResolvedValueOnce({ 'label-realtime': 1 })
        .mockResolvedValueOnce({})

      const LocationProbe = () => {
        const { search } = useLocation()
        return <span data-testid="location-search">{search}</span>
      }

      render(
        <MemoryRouter initialEntries={['/?label=label-realtime']}>
          <ToastProvider>
            <Routes>
              <Route element={<Dashboard />}>
                <Route index element={null} />
                <Route path="notes/:noteId" element={null} />
              </Route>
            </Routes>
          </ToastProvider>
          <LocationProbe />
        </MemoryRouter>
      )

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, '', false, 'label-realtime', false)
      })

      const sseOptions = vi.mocked(useSSE).mock.calls[0]?.[0]
      expect(sseOptions).toBeDefined()

      await act(async () => {
        sseOptions?.onEvent({
          type: 'labels_changed',
          source_user_id: 'user1',
          data: { label: realtimeLabel },
        })
      })

      await waitFor(() => {
        expect(labels.getAll).toHaveBeenCalledTimes(2)
      })

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, '', false, '', false)
      })

      await waitFor(() => {
        expect(screen.getByTestId('location-search').textContent ?? '').not.toContain('label=')
      })
    })
  })

  describe('My Todo Filtering', () => {
    it('loads My Todo view from URL parameter', async () => {
      const mockGetAll = vi.mocked(notes.getAll)

      renderDashboard(['/?view=my-todo'])

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith(false, '', false, '', true)
      })
    })

    it('shows empty state for My Todo with no assigned notes', async () => {
      vi.mocked(notes.getAll).mockResolvedValue([])

      renderDashboard(['/?view=my-todo'])

      await waitFor(() => {
        expect(screen.getByText('No assigned tasks')).toBeInTheDocument()
        expect(screen.getByText('No tasks assigned to you yet. When someone assigns a task to you in a shared note, it will appear here.')).toBeInTheDocument()
      })
    })

    it('shows My Todo info subtitle in My Todo view', async () => {
      vi.mocked(notes.getAll).mockResolvedValue([])

      renderDashboard(['/?view=my-todo'])

      await waitFor(() => {
        expect(screen.getByText('Showing notes that include your assigned tasks.')).toBeInTheDocument()
      })
    })

    it('sets My Todo page title when My Todo view is active', async () => {
      renderDashboard(['/?view=my-todo'])

      await waitFor(() => {
        expect(document.title).toBe('My Tasks - Jot')
      })
    })

    it('sets note title in page title when a note with a title is opened', async () => {
      const mockNote = createMockNote({ id: 'abc123', title: 'My Important Note' })
      vi.mocked(notes.getById).mockResolvedValue(mockNote)

      renderDashboard(['/notes/abc123'])

      await waitFor(() => {
        expect(screen.getByTestId('note-modal')).toBeInTheDocument()
        expect(document.title).toBe('My Important Note - Jot')
      })
    })

    it('keeps section title when a note without a title is opened', async () => {
      const mockNote = createMockNote({ id: 'abc123', title: '' })
      vi.mocked(notes.getById).mockResolvedValue(mockNote)

      renderDashboard(['/notes/abc123'])

      await waitFor(() => {
        expect(screen.getByTestId('note-modal')).toBeInTheDocument()
        expect(document.title).toBe('Jot')
      })
    })

    it('restores section title when note modal is closed', async () => {
      const user = userEvent.setup()
      const mockNote = createMockNote({ id: 'abc123', title: 'My Important Note' })
      vi.mocked(notes.getById).mockResolvedValue(mockNote)

      renderDashboard(['/notes/abc123'])

      await waitFor(() => {
        expect(document.title).toBe('My Important Note - Jot')
      })

      await user.click(screen.getByTestId('modal-close'))

      await waitFor(() => {
        expect(document.title).toBe('Jot')
      })
    })

  })
})
