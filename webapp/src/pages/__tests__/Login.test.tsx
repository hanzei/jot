import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import Login from '../Login';
import { auth } from '@/utils/api';
import { setUser, setSettings } from '@/utils/auth';
import type { SSOConfig } from '@jot/shared';
import i18n from '@/i18n';

vi.mock('@/utils/api', () => ({
  auth: {
    login: vi.fn(),
  },
  SSO_LOGIN_URL: '/api/v1/auth/oidc/login',
}));

vi.mock('@/utils/auth', () => ({
  setUser: vi.fn(),
  setSettings: vi.fn(),
}));

const SSO_DISABLED: SSOConfig = { enabled: false, provider_name: '', local_login_enabled: true };

const renderLogin = (props?: {
  registrationEnabled?: boolean;
  onLogin?: () => void;
  initialEntry?: string;
  sso?: SSOConfig;
}) => {
  const onLogin = props?.onLogin ?? vi.fn();
  const registrationEnabled = props?.registrationEnabled ?? true;
  const sso = props?.sso ?? SSO_DISABLED;

  return {
    onLogin,
    ...render(
      <MemoryRouter initialEntries={[props?.initialEntry ?? '/login']}>
        <Login onLogin={onLogin} registrationEnabled={registrationEnabled} sso={sso} />
      </MemoryRouter>
    ),
  };
};

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows logo and registration link when registration is enabled', () => {
    renderLogin();

    expect(screen.getByRole('img', { name: i18n.t('auth.logoAlt') })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: i18n.t('auth.createNewAccount') })).toHaveAttribute('href', '/register');
  });

  it('hides registration link when registration is disabled', () => {
    renderLogin({ registrationEnabled: false });

    expect(screen.queryByRole('link', { name: i18n.t('auth.createNewAccount') })).not.toBeInTheDocument();
  });

  it('toggles password visibility', async () => {
    const user = userEvent.setup();
    renderLogin();

    const passwordLabel = i18n.t('auth.passwordPlaceholder');
    const showPasswordLabel = `${i18n.t('auth.showPassword')} (${passwordLabel})`;
    const hidePasswordLabel = `${i18n.t('auth.hidePassword')} (${passwordLabel})`;
    const passwordInput = screen.getByLabelText(passwordLabel);
    expect(passwordInput).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: showPasswordLabel }));
    expect(passwordInput).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: hidePasswordLabel }));
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('submits credentials and calls login callbacks', async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn();
    const expectedUser = {
      id: 'u1',
      username: 'jotuser',
      first_name: '',
      last_name: '',
      role: 'user' as const,
      has_profile_icon: false,
      created_at: '',
      updated_at: '',
    };
    const expectedSettings = {
      user_id: 'u1',
      language: 'system',
      theme: 'system' as const,
      note_sort: 'manual' as const,
      updated_at: '',
    };
    vi.mocked(auth.login).mockResolvedValue({
      user: expectedUser,
      settings: expectedSettings,
    });

    renderLogin({ onLogin });

    await user.type(screen.getByLabelText(i18n.t('auth.usernamePlaceholder')), 'jotuser');
    await user.type(screen.getByLabelText(i18n.t('auth.passwordPlaceholder')), 'secret');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.signIn') }));

    await waitFor(() => {
      expect(auth.login).toHaveBeenCalledWith({ username: 'jotuser', password: 'secret' });
      expect(setUser).toHaveBeenCalledWith(expectedUser);
      expect(setSettings).toHaveBeenCalledWith(expectedSettings);
      expect(onLogin).toHaveBeenCalled();
    });
  });

  it('carries the redirect target over to the registration link', () => {
    renderLogin({ initialEntry: `/login?continue=${encodeURIComponent('/notes/abc123')}` });

    expect(screen.getByRole('link', { name: i18n.t('auth.createNewAccount') }))
      .toHaveAttribute('href', '/register?continue=%2Fnotes%2Fabc123');
  });

  describe('SSO', () => {
    const ssoEnabled = (localLoginEnabled: boolean): SSOConfig => ({
      enabled: true,
      provider_name: 'Keycloak',
      local_login_enabled: localLoginEnabled,
    });

    it('does not render an SSO button when SSO is disabled', () => {
      renderLogin();
      expect(screen.queryByRole('link', { name: /Sign in with/ })).not.toBeInTheDocument();
      expect(screen.getByLabelText(i18n.t('auth.usernamePlaceholder'))).toBeInTheDocument();
    });

    it('renders a full-page SSO button when enabled', () => {
      renderLogin({ sso: ssoEnabled(true) });
      const ssoButton = screen.getByRole('link', { name: 'Sign in with Keycloak' });
      expect(ssoButton).toHaveAttribute('href', '/api/v1/auth/oidc/login');
    });

    it('keeps the password form and shows a divider in mixed mode', () => {
      renderLogin({ sso: ssoEnabled(true) });
      expect(screen.getByRole('link', { name: 'Sign in with Keycloak' })).toBeInTheDocument();
      expect(screen.getByLabelText(i18n.t('auth.usernamePlaceholder'))).toBeInTheDocument();
      expect(screen.getByLabelText(i18n.t('auth.passwordPlaceholder'))).toBeInTheDocument();
      expect(screen.getByText(i18n.t('auth.ssoDivider'))).toBeInTheDocument();
    });

    it('hides the password form and register link when local login is disabled', () => {
      renderLogin({ sso: ssoEnabled(false) });
      expect(screen.getByRole('link', { name: 'Sign in with Keycloak' })).toBeInTheDocument();
      expect(screen.queryByLabelText(i18n.t('auth.usernamePlaceholder'))).not.toBeInTheDocument();
      expect(screen.queryByLabelText(i18n.t('auth.passwordPlaceholder'))).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: i18n.t('auth.signIn') })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: i18n.t('auth.createNewAccount') })).not.toBeInTheDocument();
    });
  });

  it('shows styled alert when login fails', async () => {
    const user = userEvent.setup();
    vi.mocked(auth.login).mockRejectedValue({
      response: { data: 'Invalid credentials' },
    });

    renderLogin();

    await user.type(screen.getByLabelText(i18n.t('auth.usernamePlaceholder')), 'jotuser');
    await user.type(screen.getByLabelText(i18n.t('auth.passwordPlaceholder')), 'wrong');
    await user.click(screen.getByRole('button', { name: i18n.t('auth.signIn') }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid credentials');
    expect(alert.querySelector('svg')).toBeTruthy();
  });
});
