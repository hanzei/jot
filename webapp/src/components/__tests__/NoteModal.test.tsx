import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { type ReactNode } from 'react'
import NoteModal from '../NoteModal'
import { ToastProvider } from '../Toast'
import type { Note, NoteItem } from '@jot/shared'
import { createMockNote } from '@/utils/__tests__/test-helpers'

// Mock the API module
const { mockNotesUpdate, mockNotesCreate } = vi.hoisted(() => ({
  mockNotesUpdate: vi.fn().mockResolvedValue({}),
  mockNotesCreate: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/utils/api', () => ({
  notes: {
    create: mockNotesCreate,
    update: mockNotesUpdate,
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
  },
  labels: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}))

// Mock @headlessui/react
vi.mock('@headlessui/react', () => {
  const DialogPanel = ({ className, children }: { className?: string; children?: ReactNode }) => (
    <div className={className} data-testid="dialog-panel">{children}</div>
  )

  const Dialog = ({ children, open }: { children?: ReactNode; open?: boolean }) => (
    <div data-testid="dialog" style={{ display: open ? 'block' : 'none' }}>
      {open && children}
    </div>
  )

  const DialogTitle = ({ children, className }: { children?: ReactNode; className?: string }) => (
    <h2 className={className}>{children}</h2>
  )

  return { Dialog, DialogPanel, DialogTitle }
})

// Mock @dnd-kit components
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children?: ReactNode; onDragEnd?: (event: Record<string, unknown>) => void }) => (
    <div data-testid="dnd-context" onDrop={(e) => onDragEnd && onDragEnd(e as unknown as Record<string, unknown>)}>
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
vi.spyOn(console, 'error').mockImplementation(mockConsoleError)

const createMockTodoItems = (): NoteItem[] => [
  {
    id: 'item1',
    note_id: '1',
    text: 'First item',
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
    text: 'Second item',
    completed: true,
    position: 1,
    indent_level: 0,
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

describe('NoteModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    mockConsoleError.mockClear()
    vi.useRealTimers()
  })

  describe('Basic Rendering', () => {
    it('renders create mode correctly', () => {
      renderNoteModal(defaultProps)

      expect(screen.getByText('New Note')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Note title...')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Take a note...')).toBeInTheDocument()
    })

    it('renders edit mode correctly', () => {
      const note = createMockNote()
      renderNoteModal({ ...defaultProps, note })

      expect(screen.getByText('Edit Note')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Test Note')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Test content')).toBeInTheDocument()
    })

    it('shows note type selector only for new notes', () => {
      renderNoteModal(defaultProps)

      expect(screen.getByText('Text')).toBeInTheDocument()
      expect(screen.getByText('Todo List')).toBeInTheDocument()
    })

    it('does not show note type selector for existing notes', () => {
      const note = createMockNote()
      renderNoteModal({ ...defaultProps, note })

      expect(screen.queryByText('Text')).not.toBeInTheDocument()
      expect(screen.queryByText('Todo List')).not.toBeInTheDocument()
    })

    it('displays last edited time for existing notes', () => {
      const note = createMockNote({ updated_at: '2023-01-01T12:00:00Z' })
      renderNoteModal({ ...defaultProps, note })

      expect(screen.getByText(/Last edited:/)).toBeInTheDocument()
    })

    it('renders permanent mobile app toolbar link in note modal', () => {
      const note = createMockNote()
      renderNoteModal({ ...defaultProps, note })

      const mobileLink = screen.getByTestId('note-open-mobile-app-toolbar-link')
      const href = mobileLink.getAttribute('href')
      const deepLink = new URL(href ?? '')

      expect(mobileLink).toBeInTheDocument()
      expect(deepLink.protocol).toBe('jot:')
      expect(deepLink.hostname).toBe('notes')
      expect(deepLink.pathname).toBe(`/${note.id}`)
      expect(deepLink.searchParams.get('server')).toBe(window.location.origin)
    })

    it('renders mobile app toolbar link before share action', () => {
      const note = createMockNote()
      renderNoteModal({ ...defaultProps, note, onShare: vi.fn(), isOwner: true })

      const mobileLink = screen.getByTestId('note-open-mobile-app-toolbar-link')
      const shareButton = screen.getByRole('button', { name: 'Share' })
      expect(mobileLink.compareDocumentPosition(shareButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    })

    it('does not render mobile app toolbar link for new note', () => {
      renderNoteModal(defaultProps)
      expect(screen.queryByTestId('note-open-mobile-app-toolbar-link')).not.toBeInTheDocument()
    })
  })

  describe('Form Validation', () => {
    it('handles title validation', async () => {
      renderNoteModal(defaultProps)

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

    it('handles todo item text validation', async () => {
      renderNoteModal(defaultProps)

      // Switch to todo mode
      const todoButton = screen.getByText('Todo List')
      fireEvent.click(todoButton)

      // Add a new item
      const addItemButton = screen.getByText('Add item')
      fireEvent.click(addItemButton)

      // Find the input field and add invalid content using change event
      const itemInput = screen.getByTestId('todo-item-input')
      fireEvent.change(itemInput, { target: { value: '<script>alert("xss")</script>' } })

      expect(screen.getByText(/Item text cannot contain < or > characters/)).toBeInTheDocument()
    })

    it('validates todo item length limits', async () => {
      renderNoteModal(defaultProps)

      // Switch to todo mode
      const todoButton = screen.getByText('Todo List')
      fireEvent.click(todoButton)

      // Add a new item
      const addItemButton = screen.getByText('Add item')
      fireEvent.click(addItemButton)

      // Add very long text using change event
      const itemInput = screen.getByTestId('todo-item-input')
      const longText = 'a'.repeat(501)
      fireEvent.change(itemInput, { target: { value: longText } })

      expect(screen.getByText(/Item text must be 500 characters or less/)).toBeInTheDocument()
    })

    it('shows error messages for validation failures', async () => {
      renderNoteModal(defaultProps)

      const titleInput = screen.getByPlaceholderText('Note title...')
      const longTitle = 'a'.repeat(201)
      fireEvent.change(titleInput, { target: { value: longTitle } })

      // Should show validation error
      expect(screen.getByText(/Title must be 200 characters or less/)).toBeInTheDocument()
    })

    it('shows dismiss button for error messages', async () => {
      renderNoteModal(defaultProps)

      const titleInput = screen.getByPlaceholderText('Note title...')
      const longTitle = 'a'.repeat(201)
      fireEvent.change(titleInput, { target: { value: longTitle } })

      expect(screen.getByText(/Title must be 200 characters or less/)).toBeInTheDocument()

      // Should show dismiss button
      expect(screen.getByText('×')).toBeInTheDocument()
    })
  })

  describe('Todo List Functionality', () => {
    it('switches between text and todo modes', async () => {
      renderNoteModal(defaultProps)

      // Start in text mode
      expect(screen.getByPlaceholderText('Take a note...')).toBeInTheDocument()

      // Switch to todo mode
      const todoButton = screen.getByText('Todo List')
      fireEvent.click(todoButton)

      expect(screen.getByText('Add item')).toBeInTheDocument()
      expect(screen.queryByPlaceholderText('Take a note...')).not.toBeInTheDocument()

      // Switch back to text mode
      const textButton = screen.getByText('Text')
      fireEvent.click(textButton)

      expect(screen.getByPlaceholderText('Take a note...')).toBeInTheDocument()
      expect(screen.queryByText('Add item')).not.toBeInTheDocument()
    })

    it('shows todo interface when in todo mode', async () => {
      renderNoteModal(defaultProps)

      // Switch to todo mode
      const todoButton = screen.getByText('Todo List')
      fireEvent.click(todoButton)

      // Should show add item button
      expect(screen.getByText('Add item')).toBeInTheDocument()
    })

    it('renders existing todo items', async () => {
      const todoNote = createMockNote({
        note_type: 'todo',
        items: createMockTodoItems(),
      })
      renderNoteModal({ ...defaultProps, note: todoNote })

      // Should show todo items
      expect(screen.getByDisplayValue('First item')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Second item')).toBeInTheDocument()
    })

    it('pressing Enter on the last uncompleted item creates a new item', async () => {
      renderNoteModal(defaultProps)

      // Switch to todo mode and add an item
      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      expect(inputs).toHaveLength(1)

      // Press Enter on the only (last) item
      fireEvent.keyDown(inputs[0], { key: 'Enter', code: 'Enter' })

      // A new item should have been added
      const inputsAfter = screen.getAllByTestId('todo-item-input')
      expect(inputsAfter).toHaveLength(2)
    })

    it('pressing Enter on a non-last uncompleted item inserts a new item below it', async () => {
      renderNoteModal(defaultProps)

      // Switch to todo mode and add two items
      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      expect(inputs).toHaveLength(2)

      // Give the first item a value so we can identify it after insertion
      fireEvent.change(inputs[0], { target: { value: 'first' } })
      fireEvent.change(inputs[1], { target: { value: 'second' } })

      // Press Enter on the first (non-last) item
      fireEvent.keyDown(inputs[0], { key: 'Enter', code: 'Enter' })
      await vi.runAllTimersAsync()

      // Three items total
      const inputsAfter = screen.getAllByTestId('todo-item-input')
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

    it('pressing a key other than Enter on a todo item does not create a new item', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      fireEvent.keyDown(inputs[0], { key: 'Escape', code: 'Escape' })

      expect(screen.getAllByTestId('todo-item-input')).toHaveLength(1)
    })

    it('pressing Backspace on an empty todo item deletes it', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      expect(inputs).toHaveLength(2)

      fireEvent.change(inputs[0], { target: { value: 'keep me' } })

      // Press Backspace on the second (empty) item
      fireEvent.keyDown(inputs[1], { key: 'Backspace', code: 'Backspace' })

      const inputsAfter = screen.getAllByTestId('todo-item-input')
      expect(inputsAfter).toHaveLength(1)
      expect(inputsAfter[0]).toHaveValue('keep me')
    })

    it('pressing Delete on an empty todo item deletes it', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      expect(inputs).toHaveLength(2)

      fireEvent.change(inputs[1], { target: { value: 'keep me' } })

      // Press Delete on the first (empty) item
      fireEvent.keyDown(inputs[0], { key: 'Delete', code: 'Delete' })

      const inputsAfter = screen.getAllByTestId('todo-item-input')
      expect(inputsAfter).toHaveLength(1)
      expect(inputsAfter[0]).toHaveValue('keep me')
    })

    it('pressing Backspace on a non-empty todo item does not delete it', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      fireEvent.change(inputs[0], { target: { value: 'has text' } })

      fireEvent.keyDown(inputs[0], { key: 'Backspace', code: 'Backspace' })

      expect(screen.getAllByTestId('todo-item-input')).toHaveLength(1)
      expect(screen.getByDisplayValue('has text')).toBeInTheDocument()
    })

    it('pressing Delete on a non-empty todo item does not delete it', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      fireEvent.change(inputs[0], { target: { value: 'has text' } })

      fireEvent.keyDown(inputs[0], { key: 'Delete', code: 'Delete' })

      expect(screen.getAllByTestId('todo-item-input')).toHaveLength(1)
      expect(screen.getByDisplayValue('has text')).toBeInTheDocument()
    })

    it('pressing Backspace on the only empty todo item deletes it without error', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      expect(inputs).toHaveLength(1)

      fireEvent.keyDown(inputs[0], { key: 'Backspace', code: 'Backspace' })

      expect(screen.queryAllByTestId('todo-item-input')).toHaveLength(0)
    })

    it('pressing Backspace on a whitespace-only todo item deletes it', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      fireEvent.change(inputs[0], { target: { value: '   ' } })

      fireEvent.keyDown(inputs[0], { key: 'Backspace', code: 'Backspace' })

      expect(screen.queryAllByTestId('todo-item-input')).toHaveLength(0)
    })

    it('pressing Backspace on an empty item focuses the previous item', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      fireEvent.change(inputs[0], { target: { value: 'first' } })

      // Press Backspace on the second (empty) item
      fireEvent.keyDown(inputs[1], { key: 'Backspace', code: 'Backspace' })
      await vi.runAllTimersAsync()

      const inputsAfter = screen.getAllByTestId('todo-item-input')
      expect(inputsAfter).toHaveLength(1)
      expect(inputsAfter[0]).toHaveFocus()
    })

    it('pressing Delete on an empty item focuses the next item', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      fireEvent.change(inputs[1], { target: { value: 'second' } })

      // Press Delete on the first (empty) item
      fireEvent.keyDown(inputs[0], { key: 'Delete', code: 'Delete' })
      await vi.runAllTimersAsync()

      const inputsAfter = screen.getAllByTestId('todo-item-input')
      expect(inputsAfter).toHaveLength(1)
      expect(inputsAfter[0]).toHaveFocus()
    })

    it('pressing ArrowDown moves focus to the next item', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      fireEvent.change(inputs[0], { target: { value: 'first' } })
      fireEvent.change(inputs[1], { target: { value: 'second' } })

      inputs[0].focus()
      fireEvent.keyDown(inputs[0], { key: 'ArrowDown', code: 'ArrowDown' })

      expect(inputs[1]).toHaveFocus()
    })

    it('pressing ArrowUp moves focus to the previous item', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      fireEvent.change(inputs[0], { target: { value: 'first' } })
      fireEvent.change(inputs[1], { target: { value: 'second' } })

      inputs[1].focus()
      fireEvent.keyDown(inputs[1], { key: 'ArrowUp', code: 'ArrowUp' })

      expect(inputs[0]).toHaveFocus()
    })

    it('pressing ArrowUp on the first item does not change focus', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      inputs[0].focus()
      fireEvent.keyDown(inputs[0], { key: 'ArrowUp', code: 'ArrowUp' })

      expect(inputs).toHaveLength(2)
      expect(inputs[0]).toHaveFocus()
    })

    it('pressing ArrowDown on the last item does not change focus', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
      inputs[1].focus()
      fireEvent.keyDown(inputs[1], { key: 'ArrowDown', code: 'ArrowDown' })

      expect(inputs).toHaveLength(2)
      expect(inputs[1]).toHaveFocus()
    })

    it('removing a todo item from an existing note triggers auto-save', async () => {
      const todoNote = createMockNote({
        note_type: 'todo',
        items: [
          { id: 'item1', note_id: '1', text: 'First', completed: false, position: 0, indent_level: 0, assigned_to: '', created_at: '', updated_at: '' },
          { id: 'item2', note_id: '1', text: '', completed: false, position: 1, indent_level: 0, assigned_to: '', created_at: '', updated_at: '' },
        ],
      })
      mockNotesUpdate.mockClear()
      renderNoteModal({ ...defaultProps, note: todoNote })

      const inputs = screen.getAllByTestId('todo-item-input')
      expect(inputs).toHaveLength(2)

      // Press Backspace on the empty second item
      fireEvent.keyDown(inputs[1], { key: 'Backspace', code: 'Backspace' })

      expect(screen.getAllByTestId('todo-item-input')).toHaveLength(1)
      expect(mockNotesUpdate).toHaveBeenCalledWith('1', expect.objectContaining({
        items: [expect.objectContaining({ text: 'First', position: 0 })],
      }))
    })

    it('preserves completed state when creating a new todo note', async () => {
      renderNoteModal(defaultProps)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByTestId('todo-item-input')
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
      expect(screen.getByText('Edit Note')).toBeInTheDocument()
    })

    it('handles missing note properties', () => {
      const incompleteNote = {
        id: '1',
        title: 'Test',
      } as Note

      renderNoteModal({ ...defaultProps, note: incompleteNote })

      expect(screen.getByDisplayValue('Test')).toBeInTheDocument()
    })

    it('duplicates an existing note through the toolbar button', async () => {
      const note = createMockNote()
      const onDuplicate = vi.fn().mockResolvedValue(undefined)
      const onClose = vi.fn()

      renderNoteModal({ ...defaultProps, note, onDuplicate, onClose })

      fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
      await vi.runAllTimersAsync()

      expect(mockNotesUpdate).toHaveBeenCalledWith('1', expect.objectContaining({
        title: note.title,
        content: note.content,
      }))
      expect(onDuplicate).toHaveBeenCalledWith('1')
      expect(onClose).toHaveBeenCalled()
    })
  })
})