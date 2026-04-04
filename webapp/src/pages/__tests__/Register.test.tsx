import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import Register from '../Register'
import { auth } from '@/utils/api'
import { setUser, setSettings } from '@/utils/auth'

vi.mock('@/utils/api', () => ({
  auth: {
    register: vi.fn(),
  },
}))

vi.mock('@/utils/auth', () => ({
  setUser: vi.fn(),
  setSettings: vi.fn(),
}))

const renderRegister = (onRegister = vi.fn()) => render(
  <MemoryRouter>
    <Register onRegister={onRegister} />
  </MemoryRouter>
)

describe('Register', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows logo and toggles password visibility for both password fields', async () => {
    const user = userEvent.setup()
    renderRegister()

    expect(screen.getByAltText('Jot logo')).toBeInTheDocument()

    const passwordInput = screen.getByLabelText('Password')
    const confirmInput = screen.getByLabelText('Confirm password')
    const toggleButtons = screen.getAllByRole('button', { name: 'Show password' })
    expect(passwordInput).toHaveAttribute('type', 'password')
    expect(confirmInput).toHaveAttribute('type', 'password')

    await user.click(toggleButtons[0])
    expect(passwordInput).toHaveAttribute('type', 'text')

    await user.click(toggleButtons[1])
    expect(confirmInput).toHaveAttribute('type', 'text')
  })

  it('shows inline username and password validation while typing', async () => {
    const user = userEvent.setup()
    renderRegister()

    const usernameInput = screen.getByLabelText('Username')
    const passwordInput = screen.getByLabelText('Password')
    const confirmInput = screen.getByLabelText('Confirm password')

    await user.type(usernameInput, 'a')
    expect(screen.getByText('Username must be at least 2 characters')).toBeInTheDocument()

    await user.clear(usernameInput)
    await user.type(usernameInput, 'valid_user')
    expect(screen.getByText('valid_user')).toBeInTheDocument()
    expect(screen.getByText('10/30')).toBeInTheDocument()

    await user.type(passwordInput, '123')
    expect(screen.getByText('Password must be at least 4 characters')).toBeInTheDocument()
    expect(screen.getByText('Strength: Weak', { exact: false })).toBeInTheDocument()

    await user.type(confirmInput, 'xxx')
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument()
  })

  it('shows styled alert when register API fails', async () => {
    const user = userEvent.setup()
    vi.mocked(auth.register).mockRejectedValue({
      response: { data: 'Username taken' },
    })
    renderRegister()

    await user.type(screen.getByLabelText('Username'), 'valid_user')
    await user.type(screen.getByLabelText('Password'), 'validpass')
    await user.type(screen.getByLabelText('Confirm password'), 'validpass')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Username taken')
    expect(alert.querySelector('svg')).toBeTruthy()
  })

  it('submits valid values successfully', async () => {
    const user = userEvent.setup()
    const onRegister = vi.fn()
    vi.mocked(auth.register).mockResolvedValue({
      user: { id: 'u1', username: 'valid_user', role: 'user' },
      settings: { user_id: 'u1', language: 'system', theme: 'system', note_sort: 'manual', updated_at: '' },
    })
    renderRegister(onRegister)

    await user.type(screen.getByLabelText('Username'), 'valid_user')
    await user.type(screen.getByLabelText('Password'), 'validpass')
    await user.type(screen.getByLabelText('Confirm password'), 'validpass')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(auth.register).toHaveBeenCalledWith({ username: 'valid_user', password: 'validpass' })
      expect(setUser).toHaveBeenCalled()
      expect(setSettings).toHaveBeenCalled()
      expect(onRegister).toHaveBeenCalled()
    })
  })
})
