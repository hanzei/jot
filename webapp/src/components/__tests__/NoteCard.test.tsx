import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import NoteCard from '../NoteCard'
import { ToastProvider } from '../Toast'
import type { Note, NoteItem } from '@jot/shared'
import { notes } from '@/utils/api'
import { createMockNote } from '@/utils/__tests__/test-helpers'

// Mock the API module
vi.mock('@/utils/api', () => ({
  notes: {
    update: vi.fn(),
  },
}))

// Mock console.error to silence error logs in tests
const mockConsoleError = vi.fn()
vi.spyOn(console, 'error').mockImplementation(mockConsoleError)

const createMockTodoItems = (): NoteItem[] => [
  {
    id: 'item1',
    note_id: '1',
    text: 'Uncompleted item',
    completed: false,
    position: 0,
    indent_level: 0,
    assigned_to: '',
    created_at: '2023-01-01T00:00:00Z',
    updated_at: '2023-01-01T00:00:00Z',
  },
  {
    id: 'item2',
    note_id: '1',
    text: 'Completed item',
    completed: true,
    position: 1,
    indent_level: 0,
    assigned_to: '',
    created_at: '2023-01-01T00:00:00Z',
    updated_at: '2023-01-01T00:00:00Z',
  },
]

const renderNoteCard = (props: React.ComponentProps<typeof NoteCard>) => {
  return render(<ToastProvider><NoteCard {...props} /></ToastProvider>)
}

const defaultProps = {
  note: createMockNote({ content: 'This is a test note content' }),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  currentUserId: 'user1',
}

describe('NoteCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    mockConsoleError.mockClear()
  })

  describe('Basic Rendering', () => {
    it('renders note title and content', () => {
      renderNoteCard(defaultProps)

      expect(screen.getByText('Test Note')).toBeInTheDocument()
      expect(screen.getByText('This is a test note content')).toBeInTheDocument()
    })

    it('renders note without title', () => {
      const noteWithoutTitle = createMockNote({ title: '', content: 'This is a test note content' })
      renderNoteCard({ ...defaultProps, note: noteWithoutTitle })

      expect(screen.queryByRole('heading')).not.toBeInTheDocument()
      expect(screen.getByText('This is a test note content')).toBeInTheDocument()
    })

    it('renders note with extremely long title', () => {
      const longTitle = 'A'.repeat(500)
      const noteWithLongTitle = createMockNote({ title: longTitle })
      renderNoteCard({ ...defaultProps, note: noteWithLongTitle })

      expect(screen.getByText(longTitle)).toBeInTheDocument()
    })

    it('renders note with special characters in title and content', () => {
      const specialNote = createMockNote({
        title: 'Special <>&"\'` Characters',
        content: 'Content with <script>alert("xss")</script> and emojis 🚀💡',
      })
      renderNoteCard({ ...defaultProps, note: specialNote })

      expect(screen.getByText('Special <>&"\'` Characters')).toBeInTheDocument()
      expect(screen.getByText('Content with <script>alert("xss")</script> and emojis 🚀💡')).toBeInTheDocument()
    })
  })

  describe('Color Handling', () => {
    it('handles valid color values', () => {
      const validColors = ['#ffffff', '#fbbc04', '#34a853', '#4285f4', '#ea4335', '#9aa0a6']

      validColors.forEach(color => {
        const coloredNote = createMockNote({ color })
        const { unmount } = renderNoteCard({ ...defaultProps, note: coloredNote })

        expect(screen.getByTestId('note-card')).toBeInTheDocument()

        unmount()
      })
    })

    it('handles invalid color values gracefully', () => {
      const invalidColorNote = createMockNote({ color: 'invalid-color' })
      renderNoteCard({ ...defaultProps, note: invalidColorNote })

      // Should still render without throwing errors
      expect(screen.getByText('Test Note')).toBeInTheDocument()
    })

    it('handles malformed hex colors', () => {
      const malformedColors = ['#', '#xyz', 'rgb(255,255,255)', 'blue', '#12345g']

      malformedColors.forEach((color, index) => {
        const coloredNote = createMockNote({ color, title: `Test Note ${index}` })
        const { unmount } = renderNoteCard({ ...defaultProps, note: coloredNote })

        expect(screen.getByText(`Test Note ${index}`)).toBeInTheDocument()

        unmount()
      })
    })
  })

  describe('Pin/Unpin Functionality', () => {
    it('shows pinned indicator when note is pinned', () => {
      const pinnedNote = createMockNote({ pinned: true })
      renderNoteCard({ ...defaultProps, note: pinnedNote })

      const pinIcon = screen.getByTestId('pin-icon')
      expect(pinIcon).toBeInTheDocument()
    })

    it('handles pin toggle successfully', async () => {
      const user = userEvent.setup()
      const mockUpdate = vi.mocked(notes.update)
      mockUpdate.mockResolvedValueOnce(createMockNote({ pinned: true }))

      renderNoteCard(defaultProps)

      // Hover to show menu
      await user.hover(screen.getByTestId('note-card'))

      // Click the menu button
      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      // Click pin button
      const pinButton = screen.getByText('Pin')
      await user.click(pinButton)

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith('1', expect.objectContaining({
          pinned: true,
        }))
      })
    })

    it('handles pin toggle network failure', async () => {
      const user = userEvent.setup()
      const mockUpdate = vi.mocked(notes.update)
      mockUpdate.mockRejectedValueOnce(new Error('Network error'))

      renderNoteCard(defaultProps)

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      const pinButton = screen.getByText('Pin')
      await user.click(pinButton)

      await waitFor(() => {
        expect(mockConsoleError).toHaveBeenCalledWith('Failed to toggle pin:', expect.any(Error))
      })
    })

    it('shows correct pin/unpin text based on state', async () => {
      const user = userEvent.setup()

      // Test unpinned note
      renderNoteCard(defaultProps)

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      expect(screen.getByText('Pin')).toBeInTheDocument()
    })

    it('handles concurrent pin operations', async () => {
      const user = userEvent.setup()
      const mockUpdate = vi.mocked(notes.update)
      let resolveFirst: (value: Note | PromiseLike<Note>) => void = () => { }
      let resolveSecond: (value: Note | PromiseLike<Note>) => void = () => { }

      const firstPromise = new Promise<Note>(resolve => {
        resolveFirst = resolve
      })
      const secondPromise = new Promise<Note>(resolve => {
        resolveSecond = resolve
      })

      mockUpdate
        .mockReturnValueOnce(firstPromise)
        .mockReturnValueOnce(secondPromise)

      renderNoteCard(defaultProps)

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      const pinButton = screen.getByText('Pin')

      // Start two pin operations by clicking rapidly
      await user.click(pinButton)

      // Need to reopen the menu since it closes after first click
      await user.hover(screen.getByTestId('note-card'))
      await user.click(menuButton)
      const pinButton2 = screen.getByText('Pin')
      await user.click(pinButton2)

      // Resolve in reverse order
      resolveSecond(createMockNote({ pinned: true }))
      resolveFirst(createMockNote({ pinned: true }))

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledTimes(2)
      })
    })
  })

  describe('Archive/Unarchive Functionality', () => {
    it('handles archive toggle successfully', async () => {
      const user = userEvent.setup()
      const mockUpdate = vi.mocked(notes.update)
      mockUpdate.mockResolvedValueOnce(createMockNote({ archived: true }))

      renderNoteCard(defaultProps)

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      const archiveButton = screen.getByText('Archive')
      await user.click(archiveButton)

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith('1', expect.objectContaining({
          archived: true,
        }))
      })
    })

    it('shows correct archive/unarchive text based on state', async () => {
      const user = userEvent.setup()

      const archivedNote = createMockNote({ archived: true })
      renderNoteCard({ ...defaultProps, note: archivedNote })

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      expect(screen.getByText('Unarchive')).toBeInTheDocument()
    })
  })

  describe('Duplicate Functionality', () => {
    it('shows duplicate action when a duplicate handler is provided', async () => {
      const user = userEvent.setup()
      const onDuplicate = vi.fn()

      renderNoteCard({ ...defaultProps, onDuplicate })

      await user.hover(screen.getByTestId('note-card'))
      await user.click(screen.getByRole('button', { name: 'Note options' }))

      expect(screen.getByText('Duplicate')).toBeInTheDocument()
    })

    it('calls onDuplicate with the note id', async () => {
      const user = userEvent.setup()
      const onDuplicate = vi.fn().mockResolvedValue(undefined)

      renderNoteCard({ ...defaultProps, onDuplicate })

      await user.hover(screen.getByTestId('note-card'))
      await user.click(screen.getByRole('button', { name: 'Note options' }))
      await user.click(screen.getByText('Duplicate'))

      await waitFor(() => {
        expect(onDuplicate).toHaveBeenCalledWith('1')
      })
    })
  })

  describe('Sharing Functionality', () => {
    it('shows shared user avatars when note is shared', () => {
      const sharedNote = createMockNote({
        is_shared: true,
        shared_with: [{
          id: 'share1',
          note_id: '1',
          shared_with_user_id: 'user2',
          shared_by_user_id: 'user1',
          permission_level: 'edit',
          username: 'alice',
          first_name: 'Alice',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        }],
      })
      renderNoteCard({ ...defaultProps, note: sharedNote })

      expect(screen.getByRole('img', { name: 'alice' })).toBeInTheDocument()
    })

    it('filters out current user from shared avatars', () => {
      const sharedNote = createMockNote({
        is_shared: true,
        user_id: 'other_user',
        shared_with: [{
          id: 'share1',
          note_id: '1',
          shared_with_user_id: 'user1',
          shared_by_user_id: 'other_user',
          permission_level: 'edit',
          username: 'me',
          first_name: 'Me',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        }],
      })
      renderNoteCard({ ...defaultProps, note: sharedNote })

      expect(screen.queryByRole('img', { name: 'me' })).not.toBeInTheDocument()
    })

    it('renders profile icon image when user has one', () => {
      const usersMap = new Map([['user2', { id: 'user2', username: 'alice', first_name: 'Alice', last_name: '', role: 'user', has_profile_icon: true, created_at: '', updated_at: '' }]])
      const sharedNote = createMockNote({
        is_shared: true,
        shared_with: [{
          id: 'share1',
          note_id: '1',
          shared_with_user_id: 'user2',
          shared_by_user_id: 'user1',
          permission_level: 'edit',
          username: 'alice',
          first_name: 'Alice',
          has_profile_icon: true,
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        }],
      })
      renderNoteCard({ ...defaultProps, note: sharedNote, usersById: usersMap })

      const img = screen.getByAltText('alice')
      expect(img).toBeInTheDocument()
      expect(img.tagName).toBe('IMG')
      expect(img).toHaveAttribute('src', '/api/v1/users/user2/profile-icon')
    })

    it('shows share button only for note owners', async () => {
      const user = userEvent.setup()
      const onShare = vi.fn()

      renderNoteCard({ ...defaultProps, onShare })

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      expect(screen.getByText('Share')).toBeInTheDocument()
    })

    it('does not show share button for non-owners', async () => {
      const user = userEvent.setup()
      const onShare = vi.fn()
      const notOwnedNote = createMockNote({ user_id: 'other_user' })

      renderNoteCard({ ...defaultProps, note: notOwnedNote, onShare, currentUserId: "user1" })

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      expect(screen.queryByText('Share')).not.toBeInTheDocument()
    })
  })

  describe('Delete Functionality', () => {
    it('shows delete confirmation dialog and calls onDelete when confirmed', async () => {
      const user = userEvent.setup()
      const onDelete = vi.fn()

      renderNoteCard({ ...defaultProps, onDelete })

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      const deleteMenuItem = screen.getByText('Delete')
      await user.click(deleteMenuItem)

      expect(screen.getByText('Delete note')).toBeInTheDocument()
      expect(screen.getByText('Are you sure you want to delete this note?')).toBeInTheDocument()

      const confirmButton = screen.getAllByText('Delete').find(
        el => el.closest('[class*="bg-red"]')
      )!
      await user.click(confirmButton)

      expect(onDelete).toHaveBeenCalledWith('1')
    })

    it('does not call onDelete when confirmation is cancelled', async () => {
      const user = userEvent.setup()
      const onDelete = vi.fn()

      renderNoteCard({ ...defaultProps, onDelete })

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      const deleteMenuItem = screen.getByText('Delete')
      await user.click(deleteMenuItem)

      const cancelButton = screen.getByText('Cancel')
      await user.click(cancelButton)

      expect(onDelete).not.toHaveBeenCalled()
    })

    it('only shows delete button for note owners', async () => {
      const user = userEvent.setup()
      const notOwnedNote = createMockNote({ user_id: 'other_user' })

      renderNoteCard({ ...defaultProps, note: notOwnedNote, currentUserId: "user1" })

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      expect(screen.queryByText('Delete')).not.toBeInTheDocument()
    })
  })

  describe('Todo List Rendering', () => {
    it('renders todo items correctly', () => {
      const todoNote = createMockNote({
        note_type: 'todo',
        items: createMockTodoItems(),
        content: '', // Todo notes typically have empty content
      })

      renderNoteCard({ ...defaultProps, note: todoNote })

      expect(screen.getByText('Uncompleted item')).toBeInTheDocument()
      expect(screen.getByText('+1 completed items')).toBeInTheDocument()
    })

    it('handles empty todo list', () => {
      const emptyTodoNote = createMockNote({
        note_type: 'todo',
        items: [],
      })

      renderNoteCard({ ...defaultProps, note: emptyTodoNote })

      // Should render without errors
      expect(screen.getByText('Test Note')).toBeInTheDocument()
    })

    it('handles todo list with only completed items', () => {
      const completedOnlyNote = createMockNote({
        note_type: 'todo',
        items: [{
          id: 'item1',
          note_id: '1',
          text: 'Completed item',
          completed: true,
          position: 0,
          indent_level: 0,
          assigned_to: '',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        }],
      })

      renderNoteCard({ ...defaultProps, note: completedOnlyNote })

      expect(screen.getByText('+1 completed items')).toBeInTheDocument()
    })

    it('handles todo items with extremely long text', () => {
      const longText = 'A'.repeat(1000)
      const longTextTodoNote = createMockNote({
        note_type: 'todo',
        items: [{
          id: 'item1',
          note_id: '1',
          text: longText,
          completed: false,
          position: 0,
          indent_level: 0,
          assigned_to: '',
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        }],
      })

      renderNoteCard({ ...defaultProps, note: longTextTodoNote })

      expect(screen.getByText(longText)).toBeInTheDocument()
    })

    it('applies wrapping classes for long todo preview text', () => {
      const todoNote = createMockNote({
        note_type: 'todo',
        items: [
          {
            id: 'item-wrap',
            note_id: '1',
            text: 'very long todo content that should wrap in preview',
            completed: false,
            position: 0,
            indent_level: 0,
            assigned_to: '',
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
          },
        ],
      })

      const { container } = renderNoteCard({ ...defaultProps, note: todoNote })
      const textSpan = container.querySelector('span.text-gray-700')
      expect(textSpan).toBeTruthy()
      expect(textSpan).toHaveClass('whitespace-pre-wrap')
      expect(textSpan).toHaveClass('break-words')
    })
  })

  describe('Loading States and Error Handling', () => {
    it('shows loading state during operations', async () => {
      const user = userEvent.setup()
      const mockUpdate = vi.mocked(notes.update)

      let resolvePromise: (value: Note | PromiseLike<Note>) => void = () => { }
      const promise = new Promise<Note>(resolve => {
        resolvePromise = resolve
      })
      mockUpdate.mockReturnValueOnce(promise)

      renderNoteCard(defaultProps)

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      const pinButton = screen.getByText('Pin')
      await user.click(pinButton)

      // Check loading state - note-card should have opacity-50 class
      await waitFor(() => {
        expect(screen.getByTestId('note-card')).toHaveClass('opacity-50')
      })

      // Resolve the promise
      resolvePromise!(createMockNote({ pinned: true }))

      await waitFor(() => {
        expect(screen.getByTestId('note-card')).not.toHaveClass('opacity-50')
      })
    })

    it('handles network errors gracefully', async () => {
      const user = userEvent.setup()
      const mockUpdate = vi.mocked(notes.update)
      mockUpdate.mockRejectedValueOnce(new Error('Network error'))

      renderNoteCard(defaultProps)

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      await user.click(menuButton)

      const archiveButton = screen.getByText('Archive')
      await user.click(archiveButton)

      await waitFor(() => {
        expect(mockConsoleError).toHaveBeenCalledWith('Failed to toggle archive:', expect.any(Error))
      }, { timeout: 2000 })
    })
  })

  describe('User Interaction Edge Cases', () => {
    it('handles rapid successive clicks', async () => {
      const user = userEvent.setup()
      const onEdit = vi.fn()

      renderNoteCard({ ...defaultProps, onEdit })

      const noteContent = screen.getByText('This is a test note content')

      // Simulate rapid clicking
      await user.click(noteContent)
      await user.click(noteContent)
      await user.click(noteContent)

      expect(onEdit).toHaveBeenCalledTimes(3)
    })

    it('handles keyboard navigation', async () => {
      const user = userEvent.setup()
      renderNoteCard(defaultProps)

      await user.hover(screen.getByTestId('note-card'))

      const menuButton = screen.getByRole('button', { name: 'Note options' })
      menuButton.focus()

      await user.keyboard('{Enter}')

      // Menu should be opened
      expect(screen.getByText('Pin')).toBeInTheDocument()
    })

    it('handles missing optional props gracefully', () => {
      const minimalProps = {
        note: createMockNote(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
      }

      renderNoteCard(minimalProps)

      expect(screen.getByText('Test Note')).toBeInTheDocument()
    })
  })

  describe('Data Integrity Edge Cases', () => {
    it('handles malformed note data', () => {
      const malformedNote = {
        ...createMockNote(),
        created_at: 'invalid-date',
        updated_at: null as unknown as string,
        items: null as unknown as NoteItem[],
      }

      renderNoteCard({ ...defaultProps, note: malformedNote })

      expect(screen.getByText('Test Note')).toBeInTheDocument()
    })

    it('handles missing note properties', () => {
      const incompleteNote = {
        id: '1',
        title: 'Test',
      } as Note

      renderNoteCard({ ...defaultProps, note: incompleteNote })

      expect(screen.getByText('Test')).toBeInTheDocument()
    })
  })
})