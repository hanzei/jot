import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import Admin from '../Admin'
import { ToastProvider } from '@/components/Toast'
import { admin, isAxiosError } from '@/utils/api'
import * as authUtils from '@/utils/auth'
import { VALIDATION, type User, type AdminStatsResponse } from '@jot/shared'

vi.mock('@/utils/api', () => ({
  admin: {
    getStats: vi.fn(),
    getUsers: vi.fn(),
    createUser: vi.fn(),
    updateUserRole: vi.fn(),
    deleteUser: vi.fn(),
  },
  isAxiosError: vi.fn(),
}))

vi.mock('@/utils/auth', () => ({
  getUser: vi.fn(),
  isAdmin: vi.fn().mockReturnValue(true),
}))

const currentUser: User = {
  id: 'user1',
  username: 'admin1',
  first_name: '',
  last_name: '',
  role: 'admin',
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
  has_profile_icon: false,
}

const otherUser: User = {
  id: 'user2',
  username: 'regularuser',
  first_name: '',
  last_name: '',
  role: 'user',
  created_at: '2023-01-02T00:00:00Z',
  updated_at: '2023-01-02T00:00:00Z',
  has_profile_icon: false,
}

const otherAdmin: User = {
  id: 'user3',
  username: 'otheradmin',
  first_name: '',
  last_name: '',
  role: 'admin',
  created_at: '2023-01-03T00:00:00Z',
  updated_at: '2023-01-03T00:00:00Z',
  has_profile_icon: false,
}

const mockStats: AdminStatsResponse = {
  users: { total: 3, admins: 1 },
  notes: { total: 4, text: 2, list: 2, trashed: 1, archived: 1 },
  sharing: { shared_notes: 1, share_links: 2 },
  labels: { total: 2, note_associations: 3 },
  list_items: { total: 3, completed: 1, assigned: 2 },
  storage: { database_size_bytes: 4_398_047 },
}

const renderAdmin = (passwordMinLength: number = VALIDATION.PASSWORD_MIN_LENGTH) => {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Admin passwordMinLength={passwordMinLength} />
      </ToastProvider>
    </MemoryRouter>
  )
}

describe('Admin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(authUtils.isAdmin).mockReturnValue(true)
    vi.mocked(authUtils.getUser).mockReturnValue(currentUser)
    vi.mocked(admin.getStats).mockResolvedValue(mockStats)
    vi.mocked(admin.getUsers).mockResolvedValue({ users: [currentUser, otherUser, otherAdmin] })
  })

  describe('Stats section', () => {
    it('renders grouped stats cards with formatted values', async () => {
      renderAdmin()

      await waitFor(() => {
        expect(screen.getByTestId('admin-stats-users-total')).toHaveTextContent('3')
      })

      expect(screen.getByRole('heading', { name: 'Admin' })).toBeInTheDocument()
      expect(screen.getByText('Instance Overview')).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'User Management' })).toBeInTheDocument()
      expect(screen.getByTestId('admin-stats-notes-total')).toHaveTextContent('4')
      expect(screen.getByTestId('admin-stats-shared-notes')).toHaveTextContent('1')
      expect(screen.getByTestId('admin-stats-labels-total')).toHaveTextContent('2')
      expect(screen.getByTestId('admin-stats-list-items-total')).toHaveTextContent('3')
      expect(screen.getByTestId('admin-stats-database-size')).toHaveTextContent('4.2 MB')
    })

    it('shows loading placeholders while stats are fetching', async () => {
      vi.mocked(admin.getStats).mockImplementation(() => new Promise(() => undefined))

      renderAdmin()

      await screen.findByText('regularuser')
      expect(screen.getByTestId('admin-stats-section')).toBeInTheDocument()
      expect(screen.queryByTestId('admin-stats-users-total')).not.toBeInTheDocument()
    })

    it('shows a stats error when loading fails', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        vi.mocked(admin.getStats).mockRejectedValue(new Error('boom'))

        renderAdmin()

        await waitFor(() => {
          expect(screen.getByRole('alert')).toHaveTextContent('Failed to load statistics')
        })
      } finally {
        consoleError.mockRestore()
      }
    })

    it('does not show empty state when users fail to load', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        vi.mocked(admin.getUsers).mockRejectedValue(new Error('boom'))

        renderAdmin()

        await waitFor(() => {
          expect(screen.getByRole('alert')).toHaveTextContent('Failed to load users')
        })
        expect(screen.queryByText('No users found.')).not.toBeInTheDocument()
      } finally {
        consoleError.mockRestore()
      }
    })
  })

  describe('Create user modal', () => {
    const newUser: User = {
      id: 'user4',
      username: 'new_user',
      first_name: '',
      last_name: '',
      role: 'user',
      created_at: '2023-01-04T00:00:00Z',
      updated_at: '2023-01-04T00:00:00Z',
      has_profile_icon: false,
    }

    const openCreateModal = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: /^Create User$/ }))
      return screen.getByRole('dialog', { name: 'Create New User' })
    }

    it('shows helper text and username counter', async () => {
      const user = userEvent.setup()
      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const dialog = await openCreateModal(user)

      expect(within(dialog).getByText('2–30 characters. Letters, numbers, underscores, and hyphens.')).toBeInTheDocument()
      expect(within(dialog).getByText('At least 10 characters')).toBeInTheDocument()
      expect(within(dialog).getByText(`0/${VALIDATION.USERNAME_MAX_LENGTH}`)).toBeInTheDocument()

      expect(within(dialog).getByRole('button', { name: 'Create User' })).toBeEnabled()
    })

    it('shows username validation errors only after blur', async () => {
      const user = userEvent.setup()
      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const dialog = await openCreateModal(user)

      const usernameInput = within(dialog).getByLabelText('Username')
      await user.type(usernameInput, 'bad*name')
      expect(within(dialog).queryByText('Username can only contain letters, numbers, underscores, and hyphens')).not.toBeInTheDocument()

      await user.tab()
      expect(within(dialog).getByText('Username can only contain letters, numbers, underscores, and hyphens')).toBeInTheDocument()
    })

    it('shows password validation error on blur', async () => {
      const user = userEvent.setup()
      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const dialog = await openCreateModal(user)

      const passwordInput = within(dialog).getByLabelText('Password')
      await user.type(passwordInput, '123')
      await user.tab()

      expect(within(dialog).getByText('Password must be at least 10 characters')).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Create User' })).toBeDisabled()
    })

    it('shows username edge validation error on blur', async () => {
      const user = userEvent.setup()
      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const dialog = await openCreateModal(user)

      const usernameInput = within(dialog).getByLabelText('Username')
      await user.type(usernameInput, '-validchars')
      await user.tab()

      expect(within(dialog).getByText('Username cannot start or end with underscore or hyphen')).toBeInTheDocument()
    })

    it('turns username counter red when over the max length', async () => {
      const user = userEvent.setup()
      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const dialog = await openCreateModal(user)

      const usernameInput = within(dialog).getByLabelText('Username')
      await user.type(usernameInput, 'a'.repeat(VALIDATION.USERNAME_MAX_LENGTH + 1))

      const counter = within(dialog).getByText(`${VALIDATION.USERNAME_MAX_LENGTH + 1}/${VALIDATION.USERNAME_MAX_LENGTH}`)
      expect(counter).toHaveClass('text-red-600')
    })

    it('enables submit for valid fields and creates a user', async () => {
      const user = userEvent.setup()
      vi.mocked(admin.createUser).mockResolvedValue(newUser)

      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const dialog = await openCreateModal(user)

      await user.type(within(dialog).getByLabelText('Username'), 'new_user')
      await user.type(within(dialog).getByLabelText('Password'), 'abcd123456')

      const submitButton = within(dialog).getByRole('button', { name: 'Create User' })
      expect(submitButton).toBeEnabled()

      await user.click(submitButton)

      await waitFor(() => {
        expect(admin.createUser).toHaveBeenCalledWith({
          username: 'new_user',
          password: 'abcd123456',
          role: 'user',
        })
      })
    })

    it('closes modal after successful user creation', async () => {
      const user = userEvent.setup()
      vi.mocked(admin.createUser).mockResolvedValue(newUser)

      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const dialog = await openCreateModal(user)
      await user.type(within(dialog).getByLabelText('Username'), 'new_user')
      await user.type(within(dialog).getByLabelText('Password'), 'abcd123456')
      await user.click(within(dialog).getByRole('button', { name: 'Create User' }))

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Create New User' })).not.toBeInTheDocument()
      })
    })

    it('respects the configured passwordMinLength prop instead of the hardcoded default', async () => {
      const user = userEvent.setup()
      renderAdmin(4)

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const dialog = await openCreateModal(user)

      // A 5-char password satisfies min=4 but not the hardcoded default of 10
      const passwordInput = within(dialog).getByLabelText('Password')
      await user.type(passwordInput, '12345')
      await user.tab()

      expect(within(dialog).queryByText(/Password must be at least/)).not.toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Create User' })).toBeEnabled()
    })

    it('shows server error message when create user fails', async () => {
      const user = userEvent.setup()
      vi.mocked(isAxiosError).mockReturnValue(true)
      vi.mocked(admin.createUser).mockRejectedValue({ response: { data: '  username already exists  ' } })

      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const dialog = await openCreateModal(user)
      await user.type(within(dialog).getByLabelText('Username'), 'new_user')
      await user.type(within(dialog).getByLabelText('Password'), 'abcd123456')
      await user.click(within(dialog).getByRole('button', { name: 'Create User' }))

      await waitFor(() => {
        expect(within(dialog).getByRole('alert')).toHaveTextContent('username already exists')
      })
    })
  })

  describe('Role toggle - success', () => {
    it('promotes a regular user to admin', async () => {
      const user = userEvent.setup()
      const updatedUser: User = { ...otherUser, role: 'admin' }
      vi.mocked(admin.updateUserRole).mockResolvedValue(updatedUser)

      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const userRow = screen.getByText('regularuser').closest('li')!
      const toggleButton = within(userRow).getByRole('button', { name: /Make Admin/i })
      await user.click(toggleButton)

      await waitFor(() => {
        expect(admin.updateUserRole).toHaveBeenCalledWith('user2', { role: 'admin' })
      })

      // After update, button should say "Remove Admin"
      await waitFor(() => {
        expect(within(userRow).getByRole('button', { name: /Remove Admin/i })).toBeInTheDocument()
      })
    })

    it('demotes an admin to regular user', async () => {
      const user = userEvent.setup()
      const updatedUser: User = { ...otherAdmin, role: 'user' }
      vi.mocked(admin.updateUserRole).mockResolvedValue(updatedUser)

      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('otheradmin')).toBeInTheDocument()
      })

      const userRow = screen.getByText('otheradmin').closest('li')!
      const toggleButton = within(userRow).getByRole('button', { name: /Remove Admin/i })
      await user.click(toggleButton)

      await waitFor(() => {
        expect(admin.updateUserRole).toHaveBeenCalledWith('user3', { role: 'user' })
      })

      await waitFor(() => {
        expect(within(userRow).getByRole('button', { name: /Make Admin/i })).toBeInTheDocument()
      })
    })
  })

  describe('Role toggle - failure', () => {
    it('shows axios error message when role update fails', async () => {
      const user = userEvent.setup()
      const axiosError = { response: { data: '  cannot demote the last admin  ' } }
      vi.mocked(isAxiosError).mockReturnValue(true)
      vi.mocked(admin.updateUserRole).mockRejectedValue(axiosError)

      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const userRow = screen.getByText('regularuser').closest('li')!
      const toggleButton = within(userRow).getByRole('button', { name: /Make Admin/i })
      await user.click(toggleButton)

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('cannot demote the last admin')
      })
    })

    it('shows fallback error for non-axios failures', async () => {
      const user = userEvent.setup()
      vi.mocked(isAxiosError).mockReturnValue(false)
      vi.mocked(admin.updateUserRole).mockRejectedValue(new Error('network error'))

      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const userRow = screen.getByText('regularuser').closest('li')!
      const toggleButton = within(userRow).getByRole('button', { name: /Make Admin/i })
      await user.click(toggleButton)

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Failed to update role.')
      })
    })
  })

  describe('Role toggle - self-toggle disabled', () => {
    it('disables the role toggle button for the current user', async () => {
      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('admin1')).toBeInTheDocument()
      })

      const currentUserRow = screen.getByText('admin1').closest('li')!
      const toggleButton = within(currentUserRow).getByRole('button', { name: /Remove Admin/i })
      expect(toggleButton).toBeDisabled()
    })

    it('does not call updateUserRole when clicking the disabled self-toggle', async () => {
      const user = userEvent.setup()
      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('admin1')).toBeInTheDocument()
      })

      const currentUserRow = screen.getByText('admin1').closest('li')!
      const toggleButton = within(currentUserRow).getByRole('button', { name: /Remove Admin/i })
      await user.click(toggleButton)

      expect(admin.updateUserRole).not.toHaveBeenCalled()
    })
  })

  describe('Role toggle - updating state', () => {
    it('shows updating text while role change is in flight', async () => {
      const user = userEvent.setup()
      let resolveUpdate!: (u: User) => void
      vi.mocked(admin.updateUserRole).mockImplementation(
        () => new Promise((resolve) => { resolveUpdate = resolve })
      )

      renderAdmin()

      await waitFor(() => {
        expect(screen.getByText('regularuser')).toBeInTheDocument()
      })

      const userRow = screen.getByText('regularuser').closest('li')!
      const toggleButton = within(userRow).getByRole('button', { name: /Make Admin/i })
      await user.click(toggleButton)

      // Button should show updating state and be disabled
      await waitFor(() => {
        const updatingButton = within(userRow).getByRole('button', { name: /Updating/i })
        expect(updatingButton).toBeDisabled()
      })

      // Resolve and verify it goes back to normal
      resolveUpdate({ ...otherUser, role: 'admin' })
      await waitFor(() => {
        expect(within(userRow).getByRole('button', { name: /Remove Admin/i })).not.toBeDisabled()
      })
    })
  })
})
