import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import Settings from '../Settings'
import { ToastProvider } from '@/components/Toast'
import { users, auth, sessions, isAxiosError } from '@/utils/api'
import * as authUtils from '@/utils/auth'
import type { UserSettings } from '@jot/shared'
import i18n from '@/i18n'

vi.mock('@/utils/api', () => ({
  auth: {
    logout: vi.fn(),
    me: vi.fn().mockResolvedValue({ user: { id: 'user1', username: 'testuser', role: 'user' }, settings: { user_id: 'user1', language: 'system', theme: 'system', note_sort: 'manual', updated_at: '' } }),
  },
  users: {
    updateMe: vi.fn(),
    changePassword: vi.fn(),
    uploadProfileIcon: vi.fn(),
    deleteProfileIcon: vi.fn(),
  },
  sessions: {
    list: vi.fn().mockResolvedValue([]),
    revoke: vi.fn().mockResolvedValue(undefined),
  },
  pats: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    revoke: vi.fn().mockResolvedValue(undefined),
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

const defaultSettings: UserSettings = {
  user_id: 'user1',
  language: 'system',
  theme: 'system',
  note_sort: 'manual',
  updated_at: '',
}

const activeSession = {
  id: 'session-1',
  browser: 'Chrome',
  os: 'Linux',
  is_current: false,
  created_at: '2023-01-01T00:00:00Z',
  expires_at: '2023-02-01T00:00:00Z',
}

const renderSettings = () => {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Settings passwordMinLength={10} />
      </ToastProvider>
    </MemoryRouter>
  )
}

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAxiosError).mockReturnValue(false)
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
      const mockSettings = { ...defaultSettings }
      vi.mocked(users.updateMe).mockResolvedValue({ user: updatedUser, settings: mockSettings })

      renderSettings()

      const input = screen.getByLabelText('Username')
      await user.clear(input)
      await user.type(input, 'newuser')
      await user.click(screen.getByRole('button', { name: 'Save Changes' }))

      await waitFor(() => {
        expect(users.updateMe).toHaveBeenCalledWith({ username: 'newuser', first_name: '', last_name: '' })
      })
      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent('Profile updated successfully.')
      })
      expect(authUtils.setUser).toHaveBeenCalledWith(updatedUser)
    })

    it('shows saving state while request is in flight', async () => {
      const user = userEvent.setup()
      const mockSettings = { ...defaultSettings }
      let resolveUpdate!: (r: { user: typeof mockUser; settings: typeof mockSettings }) => void
      vi.mocked(users.updateMe).mockImplementation(
        () => new Promise((resolve) => { resolveUpdate = resolve })
      )

      renderSettings()

      await user.click(screen.getByRole('button', { name: 'Save Changes' }))

      expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()

      resolveUpdate({ user: mockUser, settings: mockSettings })
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
        expect(screen.getAllByRole('alert')[0]).toHaveTextContent('username already taken')
      })
    })

    it('shows a generic error on non-axios failure', async () => {
      const user = userEvent.setup()
      vi.mocked(isAxiosError).mockReturnValue(false)
      vi.mocked(users.updateMe).mockRejectedValue(new Error('network error'))

      renderSettings()

      await user.click(screen.getByRole('button', { name: 'Save Changes' }))

      await waitFor(() => {
        expect(screen.getAllByRole('alert')[0]).toHaveTextContent('Failed to update username.')
      })
    })

    it('clears previous account error message on a new submission', async () => {
      const user = userEvent.setup()
      vi.mocked(isAxiosError).mockReturnValue(false)
      const mockSettings = { ...defaultSettings }
      vi.mocked(users.updateMe)
        .mockRejectedValueOnce(new Error('first failure'))
        .mockResolvedValueOnce({ user: mockUser, settings: mockSettings })

      renderSettings()

      // First submit — causes error
      await user.click(screen.getByRole('button', { name: 'Save Changes' }))
      await waitFor(() => expect(screen.getAllByRole('alert')[0]).toBeInTheDocument())

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

    it('calls updateMe and setSettings when language is changed', async () => {
      const user = userEvent.setup()
      const updatedSettings: UserSettings = { ...defaultSettings, language: 'de' }
      vi.mocked(users.updateMe).mockResolvedValue({ user: mockUser, settings: updatedSettings })

      renderSettings()

      await user.selectOptions(screen.getByLabelText('App language'), 'de')

      await waitFor(() => {
        expect(users.updateMe).toHaveBeenCalledWith({ language: 'de' })
      })
      await waitFor(() => {
        expect(authUtils.setSettings).toHaveBeenCalledWith(updatedSettings)
      })
    })
  })

  describe('Theme settings', () => {
    it('calls updateMe and setSettings when theme is changed', async () => {
      const user = userEvent.setup()
      const updatedSettings: UserSettings = { ...defaultSettings, theme: 'dark' }
      vi.mocked(users.updateMe).mockResolvedValue({ user: mockUser, settings: updatedSettings })

      renderSettings()

      await user.selectOptions(screen.getByLabelText('App theme'), 'dark')

      await waitFor(() => {
        expect(users.updateMe).toHaveBeenCalledWith({ theme: 'dark' })
      })
      await waitFor(() => {
        expect(authUtils.setSettings).toHaveBeenCalledWith(updatedSettings)
      })
    })
  })

  describe('Session revocation confirmation', () => {
    const getSessionsSection = async () => {
      const sessionsHeading = await screen.findByRole('heading', { name: i18n.t('settings.sessionsSection') })
      return sessionsHeading.closest('section') as HTMLElement
    }

    it('opens confirmation dialog before revoking a session', async () => {
      const user = userEvent.setup()
      vi.mocked(sessions.list).mockResolvedValue([activeSession])

      renderSettings()

      const sessionsSection = await getSessionsSection()
      await waitFor(() => {
        expect(within(sessionsSection).getByRole('button', { name: 'Revoke' })).toBeInTheDocument()
      })

      await user.click(within(sessionsSection).getByRole('button', { name: 'Revoke' }))

      expect(screen.getByRole('heading', { name: 'Revoke session' })).toBeInTheDocument()
      expect(sessions.revoke).not.toHaveBeenCalled()
    })

    it('revokes session only after confirming', async () => {
      const user = userEvent.setup()
      vi.mocked(sessions.list).mockResolvedValue([activeSession])

      renderSettings()

      const sessionsSection = await getSessionsSection()
      await user.click(within(sessionsSection).getByRole('button', { name: 'Revoke' }))
      const confirmDialog = screen.getByRole('dialog', { name: 'Revoke session' })
      await user.click(within(confirmDialog).getByRole('button', { name: 'Revoke' }))

      await waitFor(() => {
        expect(sessions.revoke).toHaveBeenCalledWith('session-1')
      })
    })

    it('does not revoke when confirmation is canceled', async () => {
      const user = userEvent.setup()
      vi.mocked(sessions.list).mockResolvedValue([activeSession])

      renderSettings()

      const sessionsSection = await getSessionsSection()
      await user.click(within(sessionsSection).getByRole('button', { name: 'Revoke' }))
      const confirmDialog = screen.getByRole('dialog', { name: 'Revoke session' })
      await user.click(within(confirmDialog).getByRole('button', { name: 'Cancel' }))

      expect(sessions.revoke).not.toHaveBeenCalled()
      await waitFor(() => {
        expect(screen.queryByRole('heading', { name: 'Revoke session' })).not.toBeInTheDocument()
      })
    })
  })
})
