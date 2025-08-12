import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import NoteCard from '../NoteCard'
import { Note } from '@/types'

// Mock the API module
vi.mock('@/utils/api', () => ({
  notes: {
    update: vi.fn(),
  },
}))

const mockNote: Note = {
  id: '1',
  title: 'Test Note',
  content: 'This is a test note content',
  note_type: 'text',
  pinned: false,
  archived: false,
  color: '#ffffff',
  user_id: 'user1',
  is_shared: false,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
  checked_items_collapsed: false,
  items: [],
  position: 0,
}

const defaultProps = {
  note: mockNote,
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  currentUserId: 'user1',
}

describe('NoteCard', () => {
  it('renders note title and content', () => {
    render(<NoteCard {...defaultProps} />)
    
    expect(screen.getByText('Test Note')).toBeInTheDocument()
    expect(screen.getByText('This is a test note content')).toBeInTheDocument()
  })

  it('shows pinned indicator when note is pinned', () => {
    const pinnedNote = { ...mockNote, pinned: true }
    render(<NoteCard {...defaultProps} note={pinnedNote} />)
    
    // Check if pin icon is present (using the SVG path)
    const pinIcon = document.querySelector('svg[viewBox="0 0 24 24"]')
    expect(pinIcon).toBeInTheDocument()
  })

  it('shows shared indicator when note is shared', () => {
    const sharedNote = { ...mockNote, is_shared: true }
    render(<NoteCard {...defaultProps} note={sharedNote} />)
    
    expect(screen.getByText('Shared')).toBeInTheDocument()
  })

  it('shows "Shared with me" when viewing someone elses shared note', () => {
    const sharedNote = { ...mockNote, is_shared: true, user_id: 'other_user' }
    render(<NoteCard {...defaultProps} note={sharedNote} />)
    
    expect(screen.getByText('Shared with me')).toBeInTheDocument()
  })
})