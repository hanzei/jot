import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NoteShare, User } from '@/types'
import { createMockNote } from '@/utils/__tests__/test-helpers'

const mockGetShares = vi.hoisted(() => vi.fn())
const mockShare = vi.hoisted(() => vi.fn())
const mockUnshare = vi.hoisted(() => vi.fn())
const mockUsersSearch = vi.hoisted(() => vi.fn())

vi.mock('@/utils/api', () => ({
  notes: {
    getShares: mockGetShares,
    share: mockShare,
    unshare: mockUnshare,
  },
  users: {
    search: mockUsersSearch,
  },
}))

import ShareModal from '../ShareModal'

const mockNote = createMockNote({ id: 'note1', title: 'Test Note' })

const mockShare1: NoteShare = {
  id: 'share1',
  note_id: 'note1',
  shared_with_user_id: 'user2',
  shared_by_user_id: 'user1',
  permission_level: 'edit',
  username: 'alice',
  first_name: 'Alice',
  last_name: 'Smith',
  has_profile_icon: false,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}

const mockUser2: User = {
  id: 'user2',
  username: 'alice',
  first_name: 'Alice',
  last_name: 'Smith',
  role: 'user',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  has_profile_icon: false,
}

const mockUser3: User = {
  id: 'user3',
  username: 'bob',
  first_name: 'Bob',
  last_name: 'Jones',
  role: 'user',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  has_profile_icon: false,
}

const defaultProps = {
  note: mockNote,
  isOpen: true,
  onClose: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetShares.mockResolvedValue([])
  mockUsersSearch.mockResolvedValue([])
})

describe('ShareModal', () => {
  describe('rendering', () => {
    it('renders the modal dialog when isOpen is true', async () => {
      render(<ShareModal {...defaultProps} />)
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    })

    it('does not render when note is null', () => {
      render(<ShareModal {...defaultProps} note={null} />)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('existing shares', () => {
    it('displays current shares on open', async () => {
      mockGetShares.mockResolvedValue([mockShare1])
      render(<ShareModal {...defaultProps} />)

      await waitFor(() => {
        expect(screen.getByText('Alice Smith')).toBeInTheDocument()
      })
    })

    it('shows "not shared yet" when there are no shares', async () => {
      mockGetShares.mockResolvedValue([])
      render(<ShareModal {...defaultProps} />)

      await waitFor(() => {
        expect(screen.getByText(/not shared with anyone yet/i)).toBeInTheDocument()
      })
    })
  })

  describe('user search and suggestions', () => {
    it('shows suggestions when typing a username that matches', async () => {
      mockUsersSearch.mockResolvedValue([mockUser2, mockUser3])
      const user = userEvent.setup()
      render(<ShareModal {...defaultProps} />)

      await waitFor(() => expect(mockUsersSearch).toHaveBeenCalled())

      const input = screen.getByRole('textbox')
      await user.type(input, 'ali')

      await waitFor(() => {
        expect(screen.getByText('Alice Smith')).toBeInTheDocument()
      })
    })

    it('hides suggestions when input is cleared', async () => {
      mockUsersSearch.mockResolvedValue([mockUser2])
      const user = userEvent.setup()
      render(<ShareModal {...defaultProps} />)

      await waitFor(() => expect(mockUsersSearch).toHaveBeenCalled())

      const input = screen.getByRole('textbox')
      await user.type(input, 'ali')
      await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument())

      await user.clear(input)
      await waitFor(() => {
        expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
      })
    })

    it('filters out users who are already shared', async () => {
      mockGetShares.mockResolvedValue([mockShare1]) // alice already shared
      mockUsersSearch.mockResolvedValue([mockUser2, mockUser3]) // alice + bob
      const user = userEvent.setup()
      render(<ShareModal {...defaultProps} />)

      await waitFor(() => expect(mockGetShares).toHaveBeenCalled())

      const input = screen.getByRole('textbox')
      await user.type(input, 'b')

      await waitFor(() => {
        expect(screen.getByText('Bob Jones')).toBeInTheDocument()
      })
      // Alice is already shared, should not appear as suggestion
      expect(screen.queryAllByText('Alice Smith')).toHaveLength(1) // only in shares list
    })
  })

  describe('sharing a note', () => {
    it('calls notes.share when a suggestion is clicked', async () => {
      mockUsersSearch.mockResolvedValue([mockUser2])
      mockShare.mockResolvedValue({ success: true, message: 'shared' })
      mockGetShares.mockResolvedValue([])
      const user = userEvent.setup()
      render(<ShareModal {...defaultProps} />)

      await waitFor(() => expect(mockUsersSearch).toHaveBeenCalled())

      const input = screen.getByRole('textbox')
      await user.type(input, 'ali')

      await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument())
      await user.click(screen.getByText('Alice Smith'))

      await waitFor(() => {
        expect(mockShare).toHaveBeenCalledWith('note1', { username: 'alice' })
      })
    })

    it('clears the input after a successful share', async () => {
      mockUsersSearch.mockResolvedValue([mockUser2])
      mockShare.mockResolvedValue({ success: true, message: 'shared' })
      mockGetShares.mockResolvedValue([])
      const user = userEvent.setup()
      render(<ShareModal {...defaultProps} />)

      await waitFor(() => expect(mockUsersSearch).toHaveBeenCalled())

      const input = screen.getByRole('textbox') as HTMLInputElement
      await user.type(input, 'ali')
      await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument())
      await user.click(screen.getByText('Alice Smith'))

      await waitFor(() => expect(input.value).toBe(''))
    })

    it('shows error message on 404 (user not found)', async () => {
      mockUsersSearch.mockResolvedValue([mockUser2])
      mockShare.mockRejectedValue({ response: { status: 404 } })
      const user = userEvent.setup()
      render(<ShareModal {...defaultProps} />)

      await waitFor(() => expect(mockUsersSearch).toHaveBeenCalled())

      const input = screen.getByRole('textbox')
      await user.type(input, 'ali')
      await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument())
      await user.click(screen.getByText('Alice Smith'))

      await waitFor(() => {
        expect(screen.getByText(/user not found/i)).toBeInTheDocument()
      })
    })

    it('shows error message on 409 (already shared)', async () => {
      mockUsersSearch.mockResolvedValue([mockUser2])
      mockShare.mockRejectedValue({ response: { status: 409 } })
      const user = userEvent.setup()
      render(<ShareModal {...defaultProps} />)

      await waitFor(() => expect(mockUsersSearch).toHaveBeenCalled())

      const input = screen.getByRole('textbox')
      await user.type(input, 'ali')
      await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument())
      await user.click(screen.getByText('Alice Smith'))

      await waitFor(() => {
        expect(screen.getByText(/already shared/i)).toBeInTheDocument()
      })
    })
  })

  describe('unsharing', () => {
    it('calls notes.unshare when the remove button is clicked', async () => {
      mockGetShares.mockResolvedValue([mockShare1])
      mockUnshare.mockResolvedValue({ success: true, message: 'unshared' })
      const user = userEvent.setup()
      render(<ShareModal {...defaultProps} />)

      await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument())

      const removeBtn = screen.getByRole('button', { name: /remove access/i })
      await user.click(removeBtn)

      await waitFor(() => {
        expect(mockUnshare).toHaveBeenCalledWith('note1', { username: 'alice' })
      })
    })
  })

  describe('keyboard navigation', () => {
    it('ArrowDown moves selection to first suggestion', async () => {
      mockUsersSearch.mockResolvedValue([mockUser2, mockUser3])
      const user = userEvent.setup()
      render(<ShareModal {...defaultProps} />)

      await waitFor(() => expect(mockUsersSearch).toHaveBeenCalled())

      const input = screen.getByRole('textbox')
      await user.type(input, 'b') // matches bob
      await waitFor(() => expect(screen.getByText('Bob Jones')).toBeInTheDocument())

      await user.keyboard('{ArrowDown}')

      // First suggestion should be highlighted (bg-blue class added via conditional).
      // We just assert that pressing Enter at this point calls share with bob.
      mockShare.mockResolvedValue({ success: true, message: 'shared' })
      await user.keyboard('{Enter}')

      await waitFor(() => {
        expect(mockShare).toHaveBeenCalledWith('note1', { username: 'bob' })
      })
    })

    it('Escape closes the suggestions dropdown', async () => {
      mockUsersSearch.mockResolvedValue([mockUser2])
      const user = userEvent.setup()
      render(<ShareModal {...defaultProps} />)

      await waitFor(() => expect(mockUsersSearch).toHaveBeenCalled())

      const input = screen.getByRole('textbox')
      await user.type(input, 'ali')
      await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument())

      await user.keyboard('{Escape}')

      await waitFor(() => {
        expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
      })
    })
  })

  describe('close behaviour', () => {
    it('calls onClose when the X button is clicked', async () => {
      const onClose = vi.fn()
      const user = userEvent.setup()
      render(<ShareModal {...defaultProps} onClose={onClose} />)

      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

      // X button is aria-label-less; find by its role within the dialog header area.
      const dialog = screen.getByRole('dialog')
      const buttons = within(dialog).getAllByRole('button')
      // The X button is the first one (top-right close icon).
      await user.click(buttons[0])

      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})
