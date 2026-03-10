import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { type ReactNode } from 'react'
import Settings from '../Settings'
import { users, auth, admin, isAxiosError } from '@/utils/api'
import * as authUtils from '@/utils/auth'

vi.mock('@/utils/api', () => ({
  auth: {
    logout: vi.fn(),
  },
  users: {
    updateMe: vi.fn(),
    changePassword: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ user_id: 'user1', language: 'system', updated_at: '' }),
    updateSettings: vi.fn().mockResolvedValue({ user_id: 'user1', language: 'system', updated_at: '' }),
  },
  admin: {
    getUsers: vi.fn(),
    updateUserRole: vi.fn(),
  },
  isAxiosError: vi.fn(),
}))

vi.mock('@/utils/auth', () => ({
  getUser: vi.fn(),
  setUser: vi.fn(),
  removeUser: vi.fn(),
  getSettings: vi.fn().mockReturnValue(null),
  setSettings: vi.fn(),
  isAdmin: vi.fn().mockReturnValue(false),
}))

vi.mock('@/components/NavigationHeader', () => ({
  default: ({ onLogout, username }: { onLogout?: () => void; username?: string; tabs?: unknown[]; children?: ReactNode }) => (
    <div data-testid="navigation-header">
      <span data-testid="displayed-username">{username}</span>
      <button onClick={onLogout} data-testid="logout-button">Logout</button>
    </div>
  ),
}))

const mockUser = {
  id: 'user1',
  username: 'testuser',
  role: 'user' as const,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
}

const renderSettings = (onLogout = vi.fn()) => {
  return render(
    <MemoryRouter>
      <Settings onLogout={onLogout} />
    </MemoryRouter>
  )
}

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(authUtils.isAdmin).mockReturnValue(false)
    vi.mocked(authUtils.getUser).mockReturnValue(mockUser)
  })

  describe('Rendering', () => {
    it('renders the settings page', () => {
      renderSettings()
      expect(screen.getByText('Settings')).toBeInTheDocument()
      expect(screen.getByLabelText('Username')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument()
    })

    it('pre-fills the username input with the current username', () => {
      renderSettings()
      expect(screen.getByLabelText('Username')).toHaveValue('testuser')
    })

    it('passes current username to the navigation header', () => {
      renderSettings()
      expect(screen.getByTestId('displayed-username')).toHaveTextContent('testuser')
    })

    it('renders without errors when user is not logged in', () => {
      vi.mocked(authUtils.getUser).mockReturnValue(null)
      renderSettings()
      expect(screen.getByLabelText('Username')).toHaveValue('')
    })
  })

  describe('Username update', () => {
    it('submits the form and updates the username on success', async () => {
      const user = userEvent.setup()
      const updatedUser = { ...mockUser, username: 'newuser' }
      vi.mocked(users.updateMe).mockResolvedValue(updatedUser)

      renderSettings()

      const input = screen.getByLabelText('Username')
      await user.clear(input)
      await user.type(input, 'newuser')
      await user.click(screen.getByRole('button', { name: 'Save Changes' }))

      await waitFor(() => {
        expect(users.updateMe).toHaveBeenCalledWith({ username: 'newuser' })
      })
      await waitFor(() => {
        expect(screen.getByText('Username updated successfully.')).toBeInTheDocument()
      })
      expect(authUtils.setUser).toHaveBeenCalledWith(updatedUser)
    })

    it('updates displayed username in nav header after successful save', async () => {
      const user = userEvent.setup()
      const updatedUser = { ...mockUser, username: 'newuser' }
      vi.mocked(users.updateMe).mockResolvedValue(updatedUser)

      renderSettings()

      const input = screen.getByLabelText('Username')
      await user.clear(input)
      await user.type(input, 'newuser')
      await user.click(screen.getByRole('button', { name: 'Save Changes' }))

      await waitFor(() => {
        expect(screen.getByTestId('displayed-username')).toHaveTextContent('newuser')
      })
    })

    it('shows saving state while request is in flight', async () => {
      const user = userEvent.setup()
      let resolveUpdate!: (u: typeof mockUser) => void
      vi.mocked(users.updateMe).mockImplementation(
        () => new Promise((resolve) => { resolveUpdate = resolve })
      )

      renderSettings()

      await user.click(screen.getByRole('button', { name: 'Save Changes' }))

      expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()

      resolveUpdate(mockUser)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument()
      })
    })

    it('shows a conflict error on 409 response', async () => {
      const user = userEvent.setup()
      const axiosError = { response: { status: 409, data: 'username already taken' } }
      vi.mocked(isAxiosError).mockReturnValue(true)
      vi.mocked(users.updateMe).mockRejectedValue(axiosError)

      renderSettings()

      await user.click(screen.getByRole('button', { name: 'Save Changes' }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('username already taken')
      })
    })

    it('shows a generic error on non-axios failure', async () => {
      const user = userEvent.setup()
      vi.mocked(isAxiosError).mockReturnValue(false)
      vi.mocked(users.updateMe).mockRejectedValue(new Error('network error'))

      renderSettings()

      await user.click(screen.getByRole('button', { name: 'Save Changes' }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Failed to update username.')
      })
    })

    it('clears previous error/success messages on a new submission', async () => {
      const user = userEvent.setup()
      vi.mocked(isAxiosError).mockReturnValue(false)
      vi.mocked(users.updateMe)
        .mockRejectedValueOnce(new Error('first failure'))
        .mockResolvedValueOnce(mockUser)

      renderSettings()

      // First submit — causes error
      await user.click(screen.getByRole('button', { name: 'Save Changes' }))
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

      // Second submit — should clear error before resolving
      await user.click(screen.getByRole('button', { name: 'Save Changes' }))
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    })
  })

  describe('Language settings', () => {
    it('fetches settings from server on mount', async () => {
      renderSettings()
      await waitFor(() => {
        expect(users.getSettings).toHaveBeenCalled()
      })
    })

    it('calls updateSettings and setSettings when language is changed', async () => {
      const user = userEvent.setup()
      const updatedSettings = { user_id: 'user1', language: 'de', updated_at: '' }
      vi.mocked(users.updateSettings).mockResolvedValue(updatedSettings)

      renderSettings()

      await user.selectOptions(screen.getByRole('combobox'), 'de')

      await waitFor(() => {
        expect(users.updateSettings).toHaveBeenCalledWith({ language: 'de' })
      })
      await waitFor(() => {
        expect(authUtils.setSettings).toHaveBeenCalledWith(updatedSettings)
      })
    })
  })

  describe('User management (admin)', () => {
    const adminUser = { ...mockUser, role: 'admin' as const }
    const otherUser = {
      id: 'user2',
      username: 'other',
      role: 'user' as const,
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
    }

    beforeEach(() => {
      vi.mocked(authUtils.isAdmin).mockReturnValue(true)
      vi.mocked(authUtils.getUser).mockReturnValue(adminUser)
      vi.mocked(admin.getUsers).mockResolvedValue({ users: [adminUser, otherUser] })
    })

    it('shows the user management section for admins', async () => {
      renderSettings()
      await waitFor(() => {
        expect(screen.getByText('User Management')).toBeInTheDocument()
      })
      expect(screen.getByText('other')).toBeInTheDocument()
    })

    it('does not show the user management section for non-admins', () => {
      vi.mocked(authUtils.isAdmin).mockReturnValue(false)
      renderSettings()
      expect(screen.queryByText('User Management')).not.toBeInTheDocument()
    })

    it('calls updateUserRole and updates the list when role toggle is clicked', async () => {
      const user = userEvent.setup()
      const promoted = { ...otherUser, role: 'admin' as const }
      vi.mocked(admin.updateUserRole).mockResolvedValue(promoted)

      renderSettings()

      await waitFor(() => {
        expect(screen.getByText('other')).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: 'Make Admin for other' }))

      await waitFor(() => {
        expect(admin.updateUserRole).toHaveBeenCalledWith(otherUser.id, { role: 'admin' })
      })
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Make Admin for other' })).not.toBeInTheDocument()
      })
    })

    it('shows an error when updateUserRole fails', async () => {
      const user = userEvent.setup()
      vi.mocked(admin.updateUserRole).mockRejectedValue(new Error('server error'))

      renderSettings()

      await waitFor(() => {
        expect(screen.getByText('other')).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: 'Make Admin for other' }))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Failed to update role.')
      })
    })

    it('clears stale error before a new role toggle attempt', async () => {
      const user = userEvent.setup()
      vi.mocked(admin.updateUserRole)
        .mockRejectedValueOnce(new Error('first error'))
        .mockResolvedValueOnce({ ...otherUser, role: 'admin' as const })

      renderSettings()

      await waitFor(() => expect(screen.getByText('other')).toBeInTheDocument())

      await user.click(screen.getByRole('button', { name: 'Make Admin for other' }))
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

      await user.click(screen.getByRole('button', { name: 'Make Admin for other' }))
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    })
  })

  describe('Logout', () => {
    it('calls logout API, removeUser, and onLogout on success', async () => {
      const user = userEvent.setup()
      const mockOnLogout = vi.fn()
      vi.mocked(auth.logout).mockResolvedValue()

      renderSettings(mockOnLogout)

      await user.click(screen.getByTestId('logout-button'))

      await waitFor(() => {
        expect(auth.logout).toHaveBeenCalled()
        expect(authUtils.removeUser).toHaveBeenCalled()
        expect(mockOnLogout).toHaveBeenCalled()
      })
    })

    it('shows an error message when logout API fails', async () => {
      const user = userEvent.setup()
      vi.mocked(auth.logout).mockRejectedValue(new Error('server error'))

      renderSettings()

      await user.click(screen.getByTestId('logout-button'))

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Logout failed')
      })
    })
  })
})
