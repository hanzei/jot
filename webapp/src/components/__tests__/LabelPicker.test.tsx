import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Label } from '@jot/shared'
import LabelPicker from '../LabelPicker'

const { mockGetAll, mockAddLabel, mockRemoveLabel } = vi.hoisted(() => ({
  mockGetAll: vi.fn(),
  mockAddLabel: vi.fn(),
  mockRemoveLabel: vi.fn(),
}))

vi.mock('@/utils/api', () => ({
  labels: { getAll: mockGetAll },
  notes: { addLabel: mockAddLabel, removeLabel: mockRemoveLabel },
}))

const makeLabel = (name: string, id = name): Label => ({
  id,
  user_id: 'user1',
  name,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
})

describe('LabelPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAll.mockResolvedValue([makeLabel('Bar'), makeLabel('Baz'), makeLabel('Other')])
  })

  it('filters labels as the user types', async () => {
    render(<LabelPicker selectedLabels={[]} onLocalChange={vi.fn()} onClose={vi.fn()} />)

    await screen.findByText('Bar')
    expect(screen.getByText('Baz')).toBeInTheDocument()
    expect(screen.getByText('Other')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ba' } })

    expect(screen.getByText('Bar')).toBeInTheDocument()
    expect(screen.getByText('Baz')).toBeInTheDocument()
    expect(screen.queryByText('Other')).not.toBeInTheDocument()
  })

  it('offers to create a label for the current input when no exact match exists', async () => {
    render(<LabelPicker selectedLabels={[]} onLocalChange={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Bar')

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New' } })
    expect(screen.getByText('Create "New"')).toBeInTheDocument()

    // No create option when the input exactly matches an existing label.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Bar' } })
    expect(screen.queryByText('Create "Bar"')).not.toBeInTheDocument()
  })

  it('adds the selected label locally for a new note', async () => {
    const onLocalChange = vi.fn()
    render(<LabelPicker selectedLabels={[]} onLocalChange={onLocalChange} onClose={vi.fn()} />)
    await screen.findByText('Bar')

    fireEvent.click(screen.getByText('Bar'))
    expect(onLocalChange).toHaveBeenCalledWith([expect.objectContaining({ name: 'Bar' })])
  })

  it('creates a new label locally from the create option', async () => {
    const onLocalChange = vi.fn()
    render(<LabelPicker selectedLabels={[]} onLocalChange={onLocalChange} onClose={vi.fn()} />)
    await screen.findByText('Bar')

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fresh' } })
    fireEvent.click(screen.getByText('Create "Fresh"'))

    expect(onLocalChange).toHaveBeenCalledWith([expect.objectContaining({ name: 'Fresh' })])
  })

  it('creates a label via the API for an existing note', async () => {
    const note = {
      id: 'note1', user_id: 'user1', note_type: 'text' as const, content: '', pinned: false,
      archived: false, color: '#fff', is_shared: false, deleted_at: null,
      created_at: '2023-01-01T00:00:00Z', updated_at: '2023-01-01T00:00:00Z', labels: [], position: 0,
    }
    mockAddLabel.mockResolvedValue({ ...note, labels: [makeLabel('Fresh')] })
    const onNoteUpdate = vi.fn()
    render(<LabelPicker note={note} onNoteUpdate={onNoteUpdate} onClose={vi.fn()} />)
    await screen.findByText('Bar')

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fresh' } })
    fireEvent.click(screen.getByText('Create "Fresh"'))

    await waitFor(() => {
      expect(mockAddLabel).toHaveBeenCalledWith('note1', 'Fresh')
      expect(onNoteUpdate).toHaveBeenCalled()
    })
  })

  it('does not fire duplicate API requests while a create is in flight', async () => {
    const note = {
      id: 'note1', user_id: 'user1', note_type: 'text' as const, content: '', pinned: false,
      archived: false, color: '#fff', is_shared: false, deleted_at: null,
      created_at: '2023-01-01T00:00:00Z', updated_at: '2023-01-01T00:00:00Z', labels: [], position: 0,
    }
    // Never-resolving promise keeps the request "in flight".
    mockAddLabel.mockReturnValue(new Promise(() => {}))
    render(<LabelPicker note={note} onClose={vi.fn()} />)
    await screen.findByText('Bar')

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Fresh' } })
    const createOption = screen.getByRole('option', { name: 'Create "Fresh"' })
    fireEvent.click(createOption)
    fireEvent.click(createOption)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mockAddLabel).toHaveBeenCalledTimes(1)
  })

  it('moves the highlight with Arrow keys', async () => {
    render(<LabelPicker selectedLabels={[]} onLocalChange={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('Bar')

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'ba' } }) // matches Bar, Baz

    const bar = screen.getByRole('option', { name: 'Bar' })
    const baz = screen.getByRole('option', { name: 'Baz' })

    // First option is highlighted by default.
    expect(bar).toHaveClass('bg-gray-100')
    expect(baz).not.toHaveClass('bg-gray-100')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(baz).toHaveClass('bg-gray-100')
    expect(bar).not.toHaveClass('bg-gray-100')

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(bar).toHaveClass('bg-gray-100')
    expect(baz).not.toHaveClass('bg-gray-100')
  })

  it('keeps Enter working when an Arrow key is pressed before labels load', async () => {
    let resolveGetAll: (labels: Label[]) => void = () => {}
    mockGetAll.mockReturnValue(new Promise<Label[]>(r => { resolveGetAll = r }))
    const onLocalChange = vi.fn()
    render(<LabelPicker selectedLabels={[]} onLocalChange={onLocalChange} onClose={vi.fn()} />)

    // ArrowDown while there are zero options must not drive highlightIndex negative.
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })

    resolveGetAll([makeLabel('Bar')])
    await screen.findByText('Bar')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onLocalChange).toHaveBeenCalledWith([expect.objectContaining({ name: 'Bar' })])
  })

  it('activates the highlighted option with the keyboard', async () => {
    const onLocalChange = vi.fn()
    render(<LabelPicker selectedLabels={[]} onLocalChange={onLocalChange} onClose={vi.fn()} />)
    await screen.findByText('Bar')

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'ba' } })
    // First option (Bar) is highlighted by default; Enter toggles it.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onLocalChange).toHaveBeenCalledWith([expect.objectContaining({ name: 'Bar' })])
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(<LabelPicker selectedLabels={[]} onLocalChange={vi.fn()} onClose={onClose} />)
    await screen.findByText('Bar')

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
