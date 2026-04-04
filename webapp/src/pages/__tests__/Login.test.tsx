import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import Login from '../Login'
import { auth } from '@/utils/api'
import { setUser, setSettings } from '@/utils/auth'

vi.mock('@/utils/api', () => ({
  auth: {
    login: vi.fn(),
  },
}))

vi.mock('@/utils/auth', () => ({
  setUser: vi.fn(),
  setSettings: vi.fn(),
}))

const renderLogin = (props?: { registrationEnabled?: boolean; onLogin?: () => void }) => {
  const onLogin = props?.onLogin ?? vi.fn()
  const registrationEnabled = props?.registrationEnabled ?? true

  return {
    onLogin,
    ...render(
      <MemoryRouter>
        <Login onLogin={onLogin} registrationEnabled={registrationEnabled} />
      </MemoryRouter>
    ),
  }
}

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows logo and registration link when registration is enabled', () => {
    renderLogin()

    expect(screen.getByAltText('Jot logo')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'create a new account' })).toHaveAttribute('href', '/register')
  })

  it('toggles password visibility', async () => {
    const user = userEvent.setup()
    renderLogin()

    const passwordInput = screen.getByLabelText('Password')
    expect(passwordInput).toHaveAttribute('type', 'password')

    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(passwordInput).toHaveAttribute('type', 'text')

    await user.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(passwordInput).toHaveAttribute('type', 'password')
  })

  it('submits credentials and calls login callbacks', async () => {
    const user = userEvent.setup()
    const onLogin = vi.fn()
    vi.mocked(auth.login).mockResolvedValue({
      user: { id: 'u1', username: 'jotuser', role: 'user' },
      settings: { user_id: 'u1', language: 'system', theme: 'system', note_sort: 'manual', updated_at: '' },
    })

    renderLogin({ onLogin })

    await user.type(screen.getByLabelText('Username'), 'jotuser')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(auth.login).toHaveBeenCalledWith({ username: 'jotuser', password: 'secret' })
      expect(setUser).toHaveBeenCalled()
      expect(setSettings).toHaveBeenCalled()
      expect(onLogin).toHaveBeenCalled()
    })
  })

  it('shows styled alert when login fails', async () => {
    const user = userEvent.setup()
    vi.mocked(auth.login).mockRejectedValue({
      response: { data: 'Invalid credentials' },
    })

    renderLogin()

    await user.type(screen.getByLabelText('Username'), 'jotuser')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Invalid credentials')
    expect(alert.querySelector('svg')).toBeTruthy()
  })
})
