import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import Register from '../Register'
import { auth } from '@/utils/api'
import { setUser, setSettings } from '@/utils/auth'
import i18n from '@/i18n'
import { VALIDATION } from '@jot/shared'

vi.mock('@/utils/api', () => ({
  auth: {
    register: vi.fn(),
  },
}))

vi.mock('@/utils/auth', () => ({
  setUser: vi.fn(),
  setSettings: vi.fn(),
}))

const renderRegister = (onRegister = vi.fn(), passwordMinLength: number = VALIDATION.PASSWORD_MIN_LENGTH) => render(
  <MemoryRouter>
    <Register onRegister={onRegister} passwordMinLength={passwordMinLength} />
  </MemoryRouter>
)

describe('Register', () => {
  const t = i18n.t.bind(i18n)
  const expectedUser = {
    id: 'u1',
    username: 'valid_user',
    role: 'user' as const,
    first_name: '',
    last_name: '',
    has_profile_icon: false,
    created_at: '',
    updated_at: '',
  }
  const expectedSettings = {
    user_id: 'u1',
    language: 'system',
    theme: 'system' as const,
    note_sort: 'manual' as const,
    updated_at: '',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows logo and toggles password visibility for both password fields', async () => {
    const user = userEvent.setup()
    renderRegister()

    expect(screen.getByAltText(t('auth.logoAlt'))).toBeInTheDocument()

    const passwordInput = screen.getByLabelText(t('auth.passwordPlaceholder'))
    const confirmInput = screen.getByLabelText(t('auth.confirmPasswordPlaceholder'))
    const passwordToggleButton = screen.getByRole('button', {
      name: `${t('auth.showPassword')} (${t('auth.passwordPlaceholder')})`,
    })
    const confirmPasswordToggleButton = screen.getByRole('button', {
      name: `${t('auth.showPassword')} (${t('auth.confirmPasswordPlaceholder')})`,
    })
    expect(passwordInput).toHaveAttribute('type', 'password')
    expect(confirmInput).toHaveAttribute('type', 'password')

    await user.click(passwordToggleButton)
    expect(passwordInput).toHaveAttribute('type', 'text')
    expect(passwordToggleButton).toHaveAttribute('aria-pressed', 'true')

    await user.click(confirmPasswordToggleButton)
    expect(confirmInput).toHaveAttribute('type', 'text')
    expect(confirmPasswordToggleButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows inline username and password validation while typing', async () => {
    const user = userEvent.setup()
    renderRegister()

    const usernameInput = screen.getByLabelText(t('auth.usernamePlaceholder'))
    const passwordInput = screen.getByLabelText(t('auth.passwordPlaceholder'))
    const confirmInput = screen.getByLabelText(t('auth.confirmPasswordPlaceholder'))

    await user.type(usernameInput, 'a')
    expect(screen.getByText(t('auth.usernameMin'))).toBeInTheDocument()

    await user.clear(usernameInput)
    await user.type(usernameInput, 'valid_user')
    expect(usernameInput).toHaveValue('valid_user')
    expect(screen.getByText(t('auth.usernamePlaceholderLong'))).toBeInTheDocument()
    expect(screen.getByText(`10/${VALIDATION.USERNAME_MAX_LENGTH}`)).toBeInTheDocument()

    await user.type(passwordInput, '123456789')
    expect(
      screen.getByText(new RegExp(t('auth.passwordMin', { min: VALIDATION.PASSWORD_MIN_LENGTH }))),
    ).toBeInTheDocument()

    await user.type(confirmInput, 'xxx')
    expect(screen.getByText(t('auth.passwordsNoMatch'))).toBeInTheDocument()
  })

  it('respects a configured passwordMinLength for inline validation', async () => {
    const user = userEvent.setup()
    renderRegister(vi.fn(), 4)

    const passwordInput = screen.getByLabelText(t('auth.passwordPlaceholder'))

    // 5-char password satisfies min=4 but not the hardcoded default of 10
    await user.type(passwordInput, '12345')
    expect(screen.queryByText(new RegExp(t('auth.passwordMin', { min: 4 })))).not.toBeInTheDocument()
    expect(passwordInput).toHaveAttribute('aria-invalid', 'false')
  })

  it('shows styled alert when register API fails', async () => {
    const user = userEvent.setup()
    vi.mocked(auth.register).mockRejectedValue({
      response: { data: 'Username taken' },
    })
    renderRegister()

    await user.type(screen.getByLabelText(t('auth.usernamePlaceholder')), 'valid_user')
    await user.type(screen.getByLabelText(t('auth.passwordPlaceholder')), 'validpass123')
    await user.type(screen.getByLabelText(t('auth.confirmPasswordPlaceholder')), 'validpass123')
    await user.click(screen.getByRole('button', { name: t('auth.createAccount') }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Username taken')
    expect(alert.querySelector('svg')).toBeTruthy()
  })

  it('submits valid values successfully', async () => {
    const user = userEvent.setup()
    const onRegister = vi.fn()
    vi.mocked(auth.register).mockResolvedValue({
      user: expectedUser,
      settings: expectedSettings,
    })
    renderRegister(onRegister)

    await user.type(screen.getByLabelText(t('auth.usernamePlaceholder')), 'valid_user')
    await user.type(screen.getByLabelText(t('auth.passwordPlaceholder')), 'validpass123')
    await user.type(screen.getByLabelText(t('auth.confirmPasswordPlaceholder')), 'validpass123')
    await user.click(screen.getByRole('button', { name: t('auth.createAccount') }))

    await waitFor(() => {
      expect(auth.register).toHaveBeenCalledWith({ username: 'valid_user', password: 'validpass123' })
      expect(setUser).toHaveBeenCalledWith(expectedUser)
      expect(setSettings).toHaveBeenCalledWith(expectedSettings)
      expect(onRegister).toHaveBeenCalled()
    })
  })
})
