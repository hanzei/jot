import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import { serverConfig, auth, publicNotes } from '@/utils/api';
import type { SSOConfig } from '@jot/shared';

vi.mock('@/utils/api', () => ({
  serverConfig: { get: vi.fn() },
  auth: { me: vi.fn(), login: vi.fn(), register: vi.fn() },
  SSO_LOGIN_URL: '/api/v1/auth/oidc/login',
  publicNotes: { get: vi.fn() },
  publicNoteImages: () => ({ url: (id: string) => id, thumbnailUrl: (id: string) => id }),
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

describe('App routing — public note links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState({}, '', '/share/q3XvT0b9Lr2Kp8WmZcE1yN4hUa7sDfGj6oBtYiR5lMw');
  });

  it('renders the viewer without checking the session or fetching config', async () => {
    vi.mocked(publicNotes.get).mockResolvedValue({
      note_type: 'text',
      title: '',
      content: 'Hello from a public link',
      updated_at: '2026-11-09T12:00:00Z',
      image_ids: [],
    });

    render(<App />);

    expect(await screen.findByText('Hello from a public link')).toBeInTheDocument();
    expect(publicNotes.get).toHaveBeenCalledWith('q3XvT0b9Lr2Kp8WmZcE1yN4hUa7sDfGj6oBtYiR5lMw');
    // A signed-in session call would 401 for an anonymous visitor.
    expect(auth.me).not.toHaveBeenCalled();
    expect(serverConfig.get).not.toHaveBeenCalled();
    expect(window.location.pathname).toMatch(/^\/share\//);
  });

  it('shows the not-found state for a dead link', async () => {
    vi.mocked(publicNotes.get).mockRejectedValue({ response: { status: 404 } });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Note not found' })).toBeInTheDocument();
  });
});
