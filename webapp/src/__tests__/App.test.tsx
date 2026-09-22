import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import { serverConfig, auth } from '@/utils/api';
import type { SSOConfig } from '@jot/shared';

vi.mock('@/utils/api', () => ({
  serverConfig: { get: vi.fn() },
  auth: { me: vi.fn(), login: vi.fn(), register: vi.fn() },
  SSO_LOGIN_URL: '/api/v1/auth/oidc/login',
}));

vi.mock('@/utils/auth', () => ({
  setUser: vi.fn(),
  setSettings: vi.fn(),
  removeUser: vi.fn(),
  isAdmin: vi.fn().mockReturnValue(false),
  getUser: vi.fn().mockReturnValue(null),
  getSettings: vi.fn().mockReturnValue(null),
}));

const config = (sso: SSOConfig) => ({
  registration_enabled: true,
  password_min_length: 10,
  upload_max_bytes: 1_000_000,
  sso,
});

describe('App routing — /register vs SSO', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Unauthenticated: the session check fails, so /register is decided by the
    // registration + local-login gate rather than an auth redirect.
    vi.mocked(auth.me).mockRejectedValue(new Error('unauthorized'));
    window.history.pushState({}, '', '/register');
  });

  it('redirects /register to /login in SSO-only mode (local login disabled)', async () => {
    vi.mocked(serverConfig.get).mockResolvedValue(
      config({ enabled: true, provider_name: 'Keycloak', local_login_enabled: false }),
    );

    render(<App />);

    // The login page took over (its SSO button is the SSO-only tell), and the
    // register form never rendered.
    expect(await screen.findByRole('link', { name: 'Sign in with Keycloak' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(screen.queryByRole('heading', { name: 'Create your account' })).not.toBeInTheDocument();
  });

  it('still renders the register page when SSO is disabled', async () => {
    vi.mocked(serverConfig.get).mockResolvedValue(
      config({ enabled: false, provider_name: '', local_login_enabled: true }),
    );

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/register');
  });
});
