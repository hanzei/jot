import { act, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import { serverConfig, auth, publicNotes, getNoteIfAccessible } from '@/utils/api';
import { getUser } from '@/utils/auth';
import type { Note, SSOConfig, User } from '@jot/shared';

vi.mock('@/utils/api', () => ({
  serverConfig: { get: vi.fn() },
  auth: { me: vi.fn(), login: vi.fn(), register: vi.fn() },
  SSO_LOGIN_URL: '/api/v1/auth/oidc/login',
  publicNotes: { get: vi.fn() },
  getNoteIfAccessible: vi.fn(),
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

const publicTextNote = {
  id: 'Ab3dEf6hIj9kLm2nOp5qRs',
  note_type: 'text' as const,
  title: '',
  content: 'Hello from a public link',
  updated_at: '2026-11-09T12:00:00Z',
  images: [],
};

describe('App routing — public note links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUser).mockReturnValue(null);
    window.history.pushState({}, '', '/share/q3XvT0b9Lr2Kp8WmZcE1yN4hUa7sDfGj6oBtYiR5lMw');
  });

  it('renders the viewer without checking the session or fetching config', async () => {
    vi.mocked(publicNotes.get).mockResolvedValue(publicTextNote);

    render(<App />);

    expect(await screen.findByText('Hello from a public link')).toBeInTheDocument();
    expect(publicNotes.get).toHaveBeenCalledWith('q3XvT0b9Lr2Kp8WmZcE1yN4hUa7sDfGj6oBtYiR5lMw');
    // A signed-in session call would 401 for an anonymous visitor.
    expect(auth.me).not.toHaveBeenCalled();
    expect(serverConfig.get).not.toHaveBeenCalled();
    expect(window.location.pathname).toMatch(/^\/share\//);
    // Nothing signed in is stored, so access to the note is not even asked.
    expect(getNoteIfAccessible).not.toHaveBeenCalled();
    expect(screen.queryByTestId('public-note-access-bar')).not.toBeInTheDocument();
  });

  it.each([
    { who: 'owner', userId: 'ownerUserId', text: 'This is how others see your note.', action: 'Edit note' },
    { who: 'collaborator', userId: 'collabUserId', text: 'This note is shared with you.', action: 'Open note' },
  ])('offers the $who a link to the note', async ({ userId, text, action }) => {
    vi.mocked(getUser).mockReturnValue({ id: userId } as User);
    vi.mocked(getNoteIfAccessible).mockResolvedValue({ id: publicTextNote.id, user_id: 'ownerUserId' } as Note);
    vi.mocked(publicNotes.get).mockResolvedValue(publicTextNote);

    render(<App />);

    const link = await screen.findByRole('link', { name: action });
    expect(link).toHaveAttribute('href', '/notes/Ab3dEf6hIj9kLm2nOp5qRs');
    expect(screen.getByTestId('public-note-access-bar')).toHaveTextContent(text);
    expect(getNoteIfAccessible).toHaveBeenCalledWith('Ab3dEf6hIj9kLm2nOp5qRs');
    expect(screen.getByText('Hello from a public link')).toBeInTheDocument();
    expect(auth.me).not.toHaveBeenCalled();
  });

  it('shows no link to a signed-in visitor who cannot open the note', async () => {
    vi.mocked(getUser).mockReturnValue({ id: 'strangerUserId' } as User);
    vi.mocked(getNoteIfAccessible).mockResolvedValue(null);
    vi.mocked(publicNotes.get).mockResolvedValue(publicTextNote);

    render(<App />);

    expect(await screen.findByText('Hello from a public link')).toBeInTheDocument();
    await vi.waitFor(() => expect(getNoteIfAccessible).toHaveBeenCalled());
    // Let the check's answer land before asserting nothing was rendered for it.
    await act(() => vi.mocked(getNoteIfAccessible).mock.results[0]!.value);
    expect(screen.queryByTestId('public-note-access-bar')).not.toBeInTheDocument();
  });

  it('shows the not-found state for a dead link', async () => {
    vi.mocked(publicNotes.get).mockRejectedValue({ response: { status: 404 } });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Note not found' })).toBeInTheDocument();
  });
});
