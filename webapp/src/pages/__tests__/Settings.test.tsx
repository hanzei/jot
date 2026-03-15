import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import { type ReactNode } from 'react'
import Settings from '../Settings'
import { users, auth, isAxiosError } from '@/utils/api'
import * as authUtils from '@/utils/auth'
import { type UserSettings } from '@/types'
import i18n from '@/i18n'

vi.mock('@/utils/api', () => ({
  auth: {
    logout: vi.fn(),
    me: vi.fn().mockResolvedValue({ user: { id: 'user1', username: 'testuser', role: 'user' }, settings: { user_id: 'user1', language: 'system', theme: 'system', updated_at: '' } }),
  },
  users: {
    updateMe: vi.fn(),
    changePassword: vi.fn(),
    updateSettings: vi.fn().mockResolvedValue({ user_id: 'user1', language: 'system', theme: 'system', updated_at: '' }),
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
  default: ({ onLogout, username, settingsLinkActive, isAdmin }: { onLogout?: () => void; username?: string; tabs?: unknown[]; children?: ReactNode; settingsLinkActive?: boolean; isAdmin?: boolean }) => (
    <div data-testid="navigation-header" data-settings-link-active={settingsLinkActive} data-is-admin={isAdmin}>
      <span data-testid="displayed-username">{username}</span>
      <button onClick={onLogout} data-testid="logout-button">Logout</button>
    </div>
  ),
}))

const mockUser = {
  id: 'user1',
  username: 'testuser',
  first_name: '',
  last_name: '',
  role: 'user' as const,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
  has_profile_icon: false,
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
    i18n.changeLanguage('en')
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

    it('passes settingsLinkActive to NavigationHeader', () => {
      renderSettings()
      expect(screen.getByTestId('navigation-header')).toHaveAttribute('data-settings-link-active', 'true')
    })

    it('passes isAdmin to NavigationHeader for non-admin user', () => {
      renderSettings()
      expect(screen.getByTestId('navigation-header')).toHaveAttribute('data-is-admin', 'false')
    })

    it('passes isAdmin to NavigationHeader for admin user', () => {
      vi.mocked(authUtils.isAdmin).mockReturnValue(true)
      renderSettings()
      expect(screen.getByTestId('navigation-header')).toHaveAttribute('data-is-admin', 'true')
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
        expect(users.updateMe).toHaveBeenCalledWith({ username: 'newuser', first_name: '', last_name: '' })
      })
      await waitFor(() => {
        expect(screen.getByText('Profile updated successfully.')).toBeInTheDocument()
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
        expect(auth.me).toHaveBeenCalled()
      })
    })

    it('calls updateSettings and setSettings when language is changed', async () => {
      const user = userEvent.setup()
      const updatedSettings: UserSettings = { user_id: 'user1', language: 'de', theme: 'system', updated_at: '' }
      vi.mocked(users.updateSettings).mockResolvedValue(updatedSettings)

      renderSettings()

      await user.selectOptions(screen.getByLabelText('App language'), 'de')

      await waitFor(() => {
        expect(users.updateSettings).toHaveBeenCalledWith({ language: 'de', theme: 'system' })
      })
      await waitFor(() => {
        expect(authUtils.setSettings).toHaveBeenCalledWith(updatedSettings)
      })
    })
  })

  describe('Theme settings', () => {
    it('calls updateSettings and setSettings when theme is changed', async () => {
      const user = userEvent.setup()
      const updatedSettings: UserSettings = { user_id: 'user1', language: 'system', theme: 'dark', updated_at: '' }
      vi.mocked(users.updateSettings).mockResolvedValue(updatedSettings)

      renderSettings()

      await user.selectOptions(screen.getByLabelText('App theme'), 'dark')

      await waitFor(() => {
        expect(users.updateSettings).toHaveBeenCalledWith({ language: 'system', theme: 'dark' })
      })
      await waitFor(() => {
        expect(authUtils.setSettings).toHaveBeenCalledWith(updatedSettings)
      })
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
