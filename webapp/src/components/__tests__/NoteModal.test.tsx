import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { type ReactNode } from 'react'
import NoteModal from '../NoteModal'
import { Note, NoteItem } from '@/types'
import { createMockNote } from '@/utils/__tests__/test-helpers'

// Mock the API module
vi.mock('@/utils/api', () => ({
  notes: {
    create: vi.fn(),
    update: vi.fn(),
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

  return { Dialog, DialogPanel }
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
    created_at: '2023-01-01T00:00:00Z',
    updated_at: '2023-01-01T00:00:00Z',
  },
]

const defaultProps = {
  onClose: vi.fn(),
  onSave: vi.fn(),
  onRefresh: vi.fn(),
}

describe('NoteModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    mockConsoleError.mockClear()
    vi.useRealTimers()
  })

  describe('Basic Rendering', () => {
    it('renders create mode correctly', () => {
      render(<NoteModal {...defaultProps} />)

      expect(screen.getByText('New Note')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Note title...')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Take a note...')).toBeInTheDocument()
    })

    it('renders edit mode correctly', () => {
      const note = createMockNote()
      render(<NoteModal {...defaultProps} note={note} />)

      expect(screen.getByText('Edit Note')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Test Note')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Test content')).toBeInTheDocument()
    })

    it('shows note type selector only for new notes', () => {
      render(<NoteModal {...defaultProps} />)

      expect(screen.getByText('Text')).toBeInTheDocument()
      expect(screen.getByText('Todo List')).toBeInTheDocument()
    })

    it('does not show note type selector for existing notes', () => {
      const note = createMockNote()
      render(<NoteModal {...defaultProps} note={note} />)

      expect(screen.queryByText('Text')).not.toBeInTheDocument()
      expect(screen.queryByText('Todo List')).not.toBeInTheDocument()
    })

    it('displays last edited time for existing notes', () => {
      const note = createMockNote({ updated_at: '2023-01-01T12:00:00Z' })
      render(<NoteModal {...defaultProps} note={note} />)

      expect(screen.getByText(/Last edited:/)).toBeInTheDocument()
    })
  })

  describe('Form Validation', () => {
    it('handles title validation', async () => {
      render(<NoteModal {...defaultProps} />)

      const titleInput = screen.getByPlaceholderText('Note title...')

      // Test maximum length - use change event instead of typing for speed
      const longTitle = 'a'.repeat(201)
      fireEvent.change(titleInput, { target: { value: longTitle } })

      expect(screen.getByText(/Title must be 200 characters or less/)).toBeInTheDocument()
    })

    it('handles content validation', async () => {
      render(<NoteModal {...defaultProps} />)

      const contentInput = screen.getByPlaceholderText('Take a note...')

      // Test maximum length - use change event instead of typing for speed
      const longContent = 'a'.repeat(10001)
      fireEvent.change(contentInput, { target: { value: longContent } })

      expect(screen.getByText(/Content must be 10000 characters or less/)).toBeInTheDocument()
    })

    it('handles todo item text validation', async () => {
      render(<NoteModal {...defaultProps} />)

      // Switch to todo mode
      const todoButton = screen.getByText('Todo List')
      fireEvent.click(todoButton)

      // Add a new item
      const addItemButton = screen.getByText('Add item')
      fireEvent.click(addItemButton)

      // Find the input field and add invalid content using change event
      const itemInput = screen.getByPlaceholderText('List item...')
      fireEvent.change(itemInput, { target: { value: '<script>alert("xss")</script>' } })

      expect(screen.getByText(/Item text cannot contain < or > characters/)).toBeInTheDocument()
    })

    it('validates todo item length limits', async () => {
      render(<NoteModal {...defaultProps} />)

      // Switch to todo mode
      const todoButton = screen.getByText('Todo List')
      fireEvent.click(todoButton)

      // Add a new item
      const addItemButton = screen.getByText('Add item')
      fireEvent.click(addItemButton)

      // Add very long text using change event
      const itemInput = screen.getByPlaceholderText('List item...')
      const longText = 'a'.repeat(501)
      fireEvent.change(itemInput, { target: { value: longText } })

      expect(screen.getByText(/Item text must be 500 characters or less/)).toBeInTheDocument()
    })

    it('shows error messages for validation failures', async () => {
      render(<NoteModal {...defaultProps} />)

      const titleInput = screen.getByPlaceholderText('Note title...')
      const longTitle = 'a'.repeat(201)
      fireEvent.change(titleInput, { target: { value: longTitle } })

      // Should show validation error
      expect(screen.getByText(/Title must be 200 characters or less/)).toBeInTheDocument()
    })

    it('shows dismiss button for error messages', async () => {
      render(<NoteModal {...defaultProps} />)

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
      render(<NoteModal {...defaultProps} />)

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
      render(<NoteModal {...defaultProps} />)

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
      render(<NoteModal {...defaultProps} note={todoNote} />)

      // Should show todo items
      expect(screen.getByDisplayValue('First item')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Second item')).toBeInTheDocument()
    })

    it('pressing Enter on the last uncompleted item creates a new item', async () => {
      render(<NoteModal {...defaultProps} />)

      // Switch to todo mode and add an item
      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByPlaceholderText('List item...')
      expect(inputs).toHaveLength(1)

      // Press Enter on the only (last) item
      fireEvent.keyDown(inputs[0], { key: 'Enter', code: 'Enter' })

      // A new item should have been added
      const inputsAfter = screen.getAllByPlaceholderText('List item...')
      expect(inputsAfter).toHaveLength(2)
    })

    it('pressing Enter on a non-last uncompleted item inserts a new item below it', async () => {
      render(<NoteModal {...defaultProps} />)

      // Switch to todo mode and add two items
      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByPlaceholderText('List item...')
      expect(inputs).toHaveLength(2)

      // Press Enter on the first (non-last) item
      fireEvent.keyDown(inputs[0], { key: 'Enter', code: 'Enter' })

      // A new item should be inserted after the first item
      const inputsAfter = screen.getAllByPlaceholderText('List item...')
      expect(inputsAfter).toHaveLength(3)
    })

    it('pressing a key other than Enter on a todo item does not create a new item', async () => {
      render(<NoteModal {...defaultProps} />)

      fireEvent.click(screen.getByText('Todo List'))
      fireEvent.click(screen.getByText('Add item'))

      const inputs = screen.getAllByPlaceholderText('List item...')
      fireEvent.keyDown(inputs[0], { key: 'Tab', code: 'Tab' })

      expect(screen.getAllByPlaceholderText('List item...')).toHaveLength(1)
    })
  })


  describe('Basic Modal Operations', () => {
    it('handles close button click', () => {
      const onClose = vi.fn()
      render(<NoteModal {...defaultProps} onClose={onClose} />)

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

      render(<NoteModal {...defaultProps} note={malformedNote} />)

      // Should render without throwing errors
      expect(screen.getByText('Edit Note')).toBeInTheDocument()
    })

    it('handles missing note properties', () => {
      const incompleteNote = {
        id: '1',
        title: 'Test',
      } as Note

      render(<NoteModal {...defaultProps} note={incompleteNote} />)

      expect(screen.getByDisplayValue('Test')).toBeInTheDocument()
    })
  })
})