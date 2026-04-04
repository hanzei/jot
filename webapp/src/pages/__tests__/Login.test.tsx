import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import Login from '../Login'
import { auth } from '@/utils/api'
import { setUser, setSettings } from '@/utils/auth'
import i18n from '@/i18n'

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

    expect(screen.getByRole('img', { name: i18n.t('auth.logoAlt') })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: i18n.t('auth.createNewAccount') })).toHaveAttribute('href', '/register')
  })

  it('hides registration link when registration is disabled', () => {
    renderLogin({ registrationEnabled: false })

    expect(screen.queryByRole('link', { name: i18n.t('auth.createNewAccount') })).not.toBeInTheDocument()
  })

  it('toggles password visibility', async () => {
    const user = userEvent.setup()
    renderLogin()

    const passwordLabel = i18n.t('auth.passwordPlaceholder')
    const showPasswordLabel = `${i18n.t('auth.showPassword')} (${passwordLabel})`
    const hidePasswordLabel = `${i18n.t('auth.hidePassword')} (${passwordLabel})`
    const passwordInput = screen.getByLabelText(passwordLabel)
    expect(passwordInput).toHaveAttribute('type', 'password')

    await user.click(screen.getByRole('button', { name: showPasswordLabel }))
    expect(passwordInput).toHaveAttribute('type', 'text')

    await user.click(screen.getByRole('button', { name: hidePasswordLabel }))
    expect(passwordInput).toHaveAttribute('type', 'password')
  })

  it('submits credentials and calls login callbacks', async () => {
    const user = userEvent.setup()
    const onLogin = vi.fn()
    vi.mocked(auth.login).mockResolvedValue({
      user: {
        id: 'u1',
        username: 'jotuser',
        first_name: '',
        last_name: '',
        role: 'user',
        has_profile_icon: false,
        created_at: '',
        updated_at: '',
      },
      settings: { user_id: 'u1', language: 'system', theme: 'system', note_sort: 'manual', updated_at: '' },
    })

    renderLogin({ onLogin })

    await user.type(screen.getByLabelText(i18n.t('auth.usernamePlaceholder')), 'jotuser')
    await user.type(screen.getByLabelText(i18n.t('auth.passwordPlaceholder')), 'secret')
    await user.click(screen.getByRole('button', { name: i18n.t('auth.signIn') }))

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

    await user.type(screen.getByLabelText(i18n.t('auth.usernamePlaceholder')), 'jotuser')
    await user.type(screen.getByLabelText(i18n.t('auth.passwordPlaceholder')), 'wrong')
    await user.click(screen.getByRole('button', { name: i18n.t('auth.signIn') }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Invalid credentials')
    expect(alert.querySelector('svg')).toBeTruthy()
  })
})
