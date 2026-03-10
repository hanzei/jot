import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { type ReactNode } from 'react'
import Admin from '../Admin'
import { admin, isAxiosError } from '@/utils/api'
import * as authUtils from '@/utils/auth'

vi.mock('@/utils/api', () => ({
  admin: {
    getUsers: vi.fn(),
    createUser: vi.fn(),
    updateUserRole: vi.fn(),
  },
  auth: {
    logout: vi.fn(),
  },
  isAxiosError: vi.fn(),
}))

vi.mock('@/utils/auth', () => ({
  getUser: vi.fn(),
  removeUser: vi.fn(),
  isAdmin: vi.fn().mockReturnValue(true),
}))

vi.mock('@/components/NavigationHeader', () => ({
  default: ({ onLogout, children }: { onLogout?: () => void; children?: ReactNode; tabs?: unknown[] }) => (
    <div data-testid="navigation-header">
      <button onClick={onLogout} data-testid="logout-button">Logout</button>
      {children}
    </div>
  ),
}))

const currentUser = {
  id: 'user1',
  username: 'admin1',
  role: 'admin' as const,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2023-01-01T00:00:00Z',
}

const otherUser = {
  id: 'user2',
  username: 'regularuser',
  role: 'user' as const,
  created_at: '2023-01-02T00:00:00Z',
  updated_at: '2023-01-02T00:00:00Z',
}

const otherAdmin = {
  id: 'user3',
  username: 'otheradmin',
  role: 'admin' as const,
  created_at: '2023-01-03T00:00:00Z',
  updated_at: '2023-01-03T00:00:00Z',
}

const renderAdmin = (onLogout = vi.fn()) => {
  return render(
    <MemoryRouter>
      <Admin onLogout={onLogout} />
    </MemoryRouter>
  )
}

describe('Admin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(authUtils.isAdmin).mockReturnValue(true)
    vi.mocked(authUtils.getUser).mockReturnValue(currentUser)
    vi.mocked(admin.getUsers).mockResolvedValue({ users: [currentUser, otherUser, otherAdmin] })
  })

  describe('Role toggle - success', () => {
    it('promotes a regular user to admin', async () => {
      const user = userEvent.setup()
      const updatedUser = { ...otherUser, role: 'admin' as const }
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
      const updatedUser = { ...otherAdmin, role: 'user' as const }
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
      let resolveUpdate!: (u: typeof otherUser) => void
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
      resolveUpdate({ ...otherUser, role: 'admin' as const })
      await waitFor(() => {
        expect(within(userRow).getByRole('button', { name: /Remove Admin/i })).not.toBeDisabled()
      })
    })
  })
})
