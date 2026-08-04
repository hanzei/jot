import React from 'react';
import { render, waitFor, act, fireEvent, cleanup, configure } from '@testing-library/react-native';
import { Text, TouchableOpacity } from 'react-native';
import { AuthProvider, useAuth } from '../src/store/AuthContext';
import { auth, getStoredSession, setOnUnauthorized, clearStoredSession, cacheAuthProfile, getCachedAuthProfile, clearCachedProfile } from '../src/api/client';
import { getLocalIdentity, enableLocalMode as persistEnableLocalMode, disableLocalMode, updateLocalSettings, updateLocalUser } from '../src/store/localMode';

const mockQueryClient = { clear: jest.fn() };
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mockQueryClient,
}));

jest.mock('../src/store/localMode', () => ({
  getLocalIdentity: jest.fn().mockResolvedValue(null),
  enableLocalMode: jest.fn(),
  disableLocalMode: jest.fn().mockResolvedValue(undefined),
  setLocalModeActive: jest.fn(),
  updateLocalSettings: jest.fn().mockResolvedValue(undefined),
  updateLocalUser: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/api/client', () => ({
  auth: {
    login: jest.fn(),
    register: jest.fn(),
    logout: jest.fn(),
    me: jest.fn(),
  },
  getStoredSession: jest.fn(),
  getStoredServerUrl: jest.fn().mockResolvedValue(null),
  restoreServerUrl: jest.fn(),
  initializeServerContext: jest.fn().mockResolvedValue(undefined),
  clearStoredSession: jest.fn(),
  setOnUnauthorized: jest.fn(),
  cacheAuthProfile: jest.fn().mockResolvedValue(undefined),
  getCachedAuthProfile: jest.fn().mockResolvedValue(null),
  clearCachedProfile: jest.fn().mockResolvedValue(undefined),
}));

const mockAuth = auth as {
  login: jest.Mock;
  register: jest.Mock;
  logout: jest.Mock;
  me: jest.Mock;
};
const mockGetStoredSession = getStoredSession as jest.Mock;
const mockSetOnUnauthorized = setOnUnauthorized as jest.Mock;
const mockClearStoredSession = clearStoredSession as jest.Mock;
const mockCacheAuthProfile = cacheAuthProfile as jest.Mock;
const mockGetCachedAuthProfile = getCachedAuthProfile as jest.Mock;
const mockClearCachedProfile = clearCachedProfile as jest.Mock;
const mockClientModule = jest.requireMock('../src/api/client') as {
  getStoredServerUrl: jest.Mock;
  restoreServerUrl: jest.Mock;
  initializeServerContext: jest.Mock;
};
const mockGetLocalIdentity = getLocalIdentity as jest.Mock;
const mockPersistEnableLocalMode = persistEnableLocalMode as jest.Mock;
const mockDisableLocalMode = disableLocalMode as jest.Mock;
const mockUpdateLocalSettings = updateLocalSettings as jest.Mock;
const mockUpdateLocalUser = updateLocalUser as jest.Mock;

function TestConsumer() {
  const { user, isAuthenticated, isLoading, revalidationFailed, logout } = useAuth();
  return (
    <>
      <Text testID="loading">{String(isLoading)}</Text>
      <Text testID="authenticated">{String(isAuthenticated)}</Text>
      <Text testID="revalidation-failed">{String(revalidationFailed)}</Text>
      <Text testID="username">{user?.username || 'none'}</Text>
      <TouchableOpacity testID="logout-button" onPress={() => logout().catch(() => {})} />
    </>
  );
}

function LoginTrigger() {
  const { login, user, isLoading } = useAuth();

  React.useEffect(() => {
    if (!isLoading && !user) {
      login('testuser', 'password').catch(() => {});
    }
  }, [isLoading, user, login]);

  return (
    <>
      <Text testID="loading">{String(isLoading)}</Text>
      <Text testID="username">{user?.username || 'none'}</Text>
    </>
  );
}

let revalidateFn: (() => Promise<boolean>) | null = null;
const CI_WAIT_TIMEOUT_MS = 4000;

function RevalidateConsumer() {
  const { user, isAuthenticated, isLoading, revalidateSession } = useAuth();
  // eslint-disable-next-line react-hooks/globals -- test probe captures render output by design
  revalidateFn = revalidateSession;
  return (
    <>
      <Text testID="loading">{String(isLoading)}</Text>
      <Text testID="authenticated">{String(isAuthenticated)}</Text>
      <Text testID="username">{user?.username || 'none'}</Text>
    </>
  );
}

const mockUser = { id: '1', username: 'testuser', first_name: '', last_name: '', role: 'user' as const, has_profile_icon: false, created_at: '', updated_at: '' };
const mockSettings = { user_id: '1', language: 'en', theme: 'system' as const, note_sort: 'manual' as const, updated_at: '' };

const localUser = { ...mockUser, id: 'local-id', username: 'local' };
const localSettings = { ...mockSettings, user_id: 'local-id' };
const localIdentity = { user: localUser, settings: localSettings };

function LocalModeConsumer() {
  const { user, isAuthenticated, isLoading, isLocalMode, enableLocalMode, logout } = useAuth();
  return (
    <>
      <Text testID="loading">{String(isLoading)}</Text>
      <Text testID="authenticated">{String(isAuthenticated)}</Text>
      <Text testID="local-mode">{String(isLocalMode)}</Text>
      <Text testID="username">{user?.username || 'none'}</Text>
      <TouchableOpacity testID="enable-local-button" onPress={() => enableLocalMode().catch(() => {})} />
      <TouchableOpacity testID="logout-button" onPress={() => logout().catch(() => {})} />
    </>
  );
}

function SettingsConsumer() {
  const { isLocalMode, settings, setSettings, setUser } = useAuth();
  return (
    <>
      <Text testID="local-mode">{String(isLocalMode)}</Text>
      <Text testID="language">{settings?.language ?? 'none'}</Text>
      <TouchableOpacity
        testID="change-settings"
        onPress={() => setSettings({ ...localSettings, language: 'de' })}
      />
      <TouchableOpacity
        testID="change-user"
        onPress={() => setUser({ ...localUser, first_name: 'Renamed' })}
      />
    </>
  );
}

describe('AuthContext', () => {
  beforeAll(() => {
    configure({ asyncUtilTimeout: CI_WAIT_TIMEOUT_MS });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStoredSession.mockResolvedValue(null);
    mockClientModule.getStoredServerUrl.mockResolvedValue(null);
    mockGetLocalIdentity.mockResolvedValue(null);
    mockDisableLocalMode.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    configure({ asyncUtilTimeout: 1000 });
  });

  it('starts with isLoading true and no user', async () => {
    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    expect(getByTestId('loading').props.children).toBe('true');

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });
    expect(getByTestId('loading').props.children).toBe('false');
    expect(getByTestId('authenticated').props.children).toBe('false');
    expect(getByTestId('username').props.children).toBe('none');
    unmount();
  }, 15000);

  it('restores session on mount when token exists', async () => {
    mockClientModule.getStoredServerUrl.mockResolvedValue('https://a.example.com');
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockAuth.me.mockResolvedValue({ user: { ...mockUser, username: 'restored' }, settings: mockSettings });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('true');
    expect(getByTestId('username').props.children).toBe('restored');
    expect(mockClientModule.initializeServerContext).toHaveBeenCalled();
    expect(mockClientModule.restoreServerUrl).toHaveBeenCalledWith('https://a.example.com');
    unmount();
  });

  it('login sets user on success', async () => {
    mockAuth.login.mockResolvedValue({ user: mockUser, settings: mockSettings });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <LoginTrigger />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    await waitFor(() => {
      expect(getByTestId('username').props.children).toBe('testuser');
    });

    expect(mockAuth.login).toHaveBeenCalledWith({ username: 'testuser', password: 'password' });
    unmount();
  });

  it('logout clears user state', async () => {
    mockGetStoredSession.mockResolvedValue('token');
    mockAuth.me.mockResolvedValue({ user: mockUser, settings: mockSettings });
    mockAuth.logout.mockResolvedValue(undefined);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('true');
    });

    await act(async () => {
      fireEvent.press(getByTestId('logout-button'));
    });

    expect(mockAuth.logout).toHaveBeenCalled();
    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('false');
    });
    expect(getByTestId('username').props.children).toBe('none');
    unmount();
  });

  it('logout clears state even when auth.logout rejects', async () => {
    mockGetStoredSession.mockResolvedValue('token');
    mockAuth.me.mockResolvedValue({ user: mockUser, settings: mockSettings });
    mockAuth.logout.mockRejectedValue(new Error('network error'));

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('true');
    });

    await act(async () => {
      fireEvent.press(getByTestId('logout-button'));
    });

    expect(mockAuth.logout).toHaveBeenCalled();
    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('false');
    });
    expect(getByTestId('username').props.children).toBe('none');
    unmount();
  });

  it('unauthorized callback clears auth state', async () => {
    let unauthorizedCb: (() => void) | null = null;
    mockSetOnUnauthorized.mockImplementation((cb: (() => void) | null) => {
      unauthorizedCb = cb;
    });

    mockGetStoredSession.mockResolvedValue('token');
    mockAuth.me.mockResolvedValue({ user: mockUser, settings: mockSettings });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('true');
    });

    await act(async () => {
      unauthorizedCb?.();
    });

    expect(getByTestId('authenticated').props.children).toBe('false');
    expect(getByTestId('username').props.children).toBe('none');
    unmount();
  });

  it('caches profile on successful session restore', async () => {
    const response = { user: mockUser, settings: mockSettings };
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockAuth.me.mockResolvedValue(response);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('true');
    });

    expect(mockCacheAuthProfile).toHaveBeenCalledWith(response);
    unmount();
  });

  it('restores from cached profile on network error during session restore', async () => {
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockAuth.me.mockRejectedValue(new Error('Network Error'));
    mockGetCachedAuthProfile.mockResolvedValue({ user: { ...mockUser, username: 'cached' }, settings: mockSettings });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('true');
    expect(getByTestId('username').props.children).toBe('cached');
    expect(mockClearStoredSession).not.toHaveBeenCalled();
    unmount();
  });

  it('does not restore when cached profile has no settings', async () => {
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockAuth.me.mockRejectedValue(new Error('Network Error'));
    mockGetCachedAuthProfile.mockResolvedValue({ user: mockUser, settings: null });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('false');
    unmount();
  });

  it('does not restore when cached profile has no user', async () => {
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockAuth.me.mockRejectedValue(new Error('Network Error'));
    mockGetCachedAuthProfile.mockResolvedValue({ user: null, settings: mockSettings });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('false');
    unmount();
  });

  it('shows login when network error and no cached profile', async () => {
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockAuth.me.mockRejectedValue(new Error('Network Error'));
    mockGetCachedAuthProfile.mockResolvedValue(null);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('false');
    unmount();
  });

  it('clears cached profile on 401 during session restore', async () => {
    mockGetStoredSession.mockResolvedValue('expired-token');
    mockAuth.me.mockRejectedValue({ response: { status: 401 } });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(mockClearStoredSession).toHaveBeenCalled();
    expect(mockClearCachedProfile).toHaveBeenCalled();
    expect(getByTestId('authenticated').props.children).toBe('false');
    unmount();
  });

  it('keeps the cached profile and flags revalidation failure on 403 during session restore', async () => {
    // A permanent non-401 error (server reachable but rejecting) must not force a
    // logout: keep the cached profile visible and surface the warning banner,
    // matching revalidateSession's policy.
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockAuth.me.mockRejectedValue({ response: { status: 403 } });
    mockGetCachedAuthProfile.mockResolvedValue({ user: { ...mockUser, username: 'cached' }, settings: mockSettings });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('true');
    expect(getByTestId('username').props.children).toBe('cached');
    expect(getByTestId('revalidation-failed').props.children).toBe('true');
    expect(mockClearStoredSession).not.toHaveBeenCalled();
    unmount();
  });

  it('stays authenticated on a transient 5xx during session restore without flagging revalidation', async () => {
    // A server hiccup (503) on launch must not log the user out or nag them:
    // render the cached profile and stay silent, since the error is transient.
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockAuth.me.mockRejectedValue({ response: { status: 503 } });
    mockGetCachedAuthProfile.mockResolvedValue({ user: { ...mockUser, username: 'cached' }, settings: mockSettings });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('true');
    expect(getByTestId('username').props.children).toBe('cached');
    expect(getByTestId('revalidation-failed').props.children).toBe('false');
    expect(mockClearStoredSession).not.toHaveBeenCalled();
    unmount();
  });

  it('shows login on a non-401 http error when there is no cached profile', async () => {
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockAuth.me.mockRejectedValue({ response: { status: 500 } });
    mockGetCachedAuthProfile.mockResolvedValue(null);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('false');
    // The stored session is preserved so a later launch can retry (only 401 clears it).
    expect(mockClearStoredSession).not.toHaveBeenCalled();
    unmount();
  });

  it('shows login on a transient network error with no cached profile without flagging revalidation', async () => {
    // Complements the 500/no-cache case above: a bare network error (no `.response`)
    // is transient too, so it must not clear the stored session or the (absent)
    // revalidation warning.
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockAuth.me.mockRejectedValue(new Error('Network Error'));
    mockGetCachedAuthProfile.mockResolvedValue(null);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('false');
    expect(getByTestId('revalidation-failed').props.children).toBe('false');
    expect(mockClearStoredSession).not.toHaveBeenCalled();
    unmount();
  });

  it('renders the cached profile immediately while auth.me() revalidates in the background', async () => {
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockGetCachedAuthProfile.mockResolvedValue({ user: { ...mockUser, username: 'cached' }, settings: mockSettings });
    let resolveMe!: (value: { user: typeof mockUser; settings: typeof mockSettings }) => void;
    mockAuth.me.mockReturnValue(
      new Promise((resolve) => {
        resolveMe = resolve;
      }),
    );

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    // Renders from cache without waiting for auth.me() to resolve.
    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });
    expect(getByTestId('authenticated').props.children).toBe('true');
    expect(getByTestId('username').props.children).toBe('cached');

    await act(async () => {
      resolveMe({ user: { ...mockUser, username: 'revalidated' }, settings: mockSettings });
    });

    await waitFor(() => {
      expect(getByTestId('username').props.children).toBe('revalidated');
    });
    expect(mockCacheAuthProfile).toHaveBeenCalledWith({ user: { ...mockUser, username: 'revalidated' }, settings: mockSettings });
    unmount();
  });

  it('caches profile on successful login', async () => {
    const response = { user: mockUser, settings: mockSettings };
    mockAuth.login.mockResolvedValue(response);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <LoginTrigger />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('username').props.children).toBe('testuser');
    });

    expect(mockCacheAuthProfile).toHaveBeenCalledWith(response);
    unmount();
  });

  it('revalidateSession updates user and caches profile on success', async () => {
    mockGetStoredSession.mockResolvedValue(null);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <RevalidateConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });
    expect(getByTestId('authenticated').props.children).toBe('false');

    const updatedResponse = { user: { ...mockUser, username: 'revalidated' }, settings: mockSettings };
    mockAuth.me.mockResolvedValue(updatedResponse);
    expect(revalidateFn).not.toBeNull();

    await act(async () => {
      await revalidateFn!();
    });

    expect(getByTestId('authenticated').props.children).toBe('true');
    expect(getByTestId('username').props.children).toBe('revalidated');
    expect(mockCacheAuthProfile).toHaveBeenCalledWith(updatedResponse);
    unmount();
  });

  it('revalidateSession clears auth on 401', async () => {
    mockGetStoredSession.mockResolvedValue('token');
    mockAuth.me.mockResolvedValueOnce({ user: mockUser, settings: mockSettings });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <RevalidateConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('true');
    });

    mockAuth.me.mockRejectedValueOnce({ response: { status: 401 } });
    expect(revalidateFn).not.toBeNull();

    await act(async () => {
      await revalidateFn!();
    });

    expect(getByTestId('authenticated').props.children).toBe('false');
    expect(mockClearStoredSession).toHaveBeenCalled();
    expect(mockClearCachedProfile).toHaveBeenCalled();
    unmount();
  });

  it('revalidateSession ignores network errors when there is no newer cached profile', async () => {
    mockGetStoredSession.mockResolvedValue('token');
    mockAuth.me.mockResolvedValueOnce({ user: mockUser, settings: mockSettings });
    // No cached profile for the still-active server: nothing to fall back to.
    mockGetCachedAuthProfile.mockResolvedValue(null);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <RevalidateConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('true');
    });

    mockAuth.me.mockRejectedValueOnce(new Error('Network Error'));
    expect(revalidateFn).not.toBeNull();

    await act(async () => {
      await revalidateFn!();
    });

    // User stays authenticated on network error
    expect(getByTestId('authenticated').props.children).toBe('true');
    expect(getByTestId('username').props.children).toBe('testuser');
    unmount();
  });

  it('revalidateSession falls back to the (newly-active) server\'s cached profile on network error', async () => {
    // Simulates switching to another server while offline: client.ts's
    // activeServerId already points at the new server, so getCachedAuthProfile()
    // resolves that server's own cached profile even though auth.me() can't
    // reach it. Without this fallback the drawer would keep showing the
    // previously-active server's name/avatar.
    mockGetStoredSession.mockResolvedValue('token');
    mockAuth.me.mockResolvedValueOnce({ user: mockUser, settings: mockSettings });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <RevalidateConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('true');
    });

    mockAuth.me.mockRejectedValueOnce(new Error('Network Error'));
    mockGetCachedAuthProfile.mockResolvedValue({
      user: { ...mockUser, username: 'other-server-user' },
      settings: mockSettings,
    });
    expect(revalidateFn).not.toBeNull();

    await act(async () => {
      await revalidateFn!();
    });

    expect(getByTestId('authenticated').props.children).toBe('true');
    expect(getByTestId('username').props.children).toBe('other-server-user');
    unmount();
  });

  it('restores local mode on mount without calling /me', async () => {
    mockGetLocalIdentity.mockResolvedValue(localIdentity);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <LocalModeConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('true');
    expect(getByTestId('local-mode').props.children).toBe('true');
    expect(getByTestId('username').props.children).toBe('local');
    expect(mockAuth.me).not.toHaveBeenCalled();
    expect(mockClientModule.initializeServerContext).not.toHaveBeenCalled();
    unmount();
  });

  it('enableLocalMode signs in with the on-device identity', async () => {
    mockPersistEnableLocalMode.mockResolvedValue(localIdentity);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <LocalModeConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });
    expect(getByTestId('authenticated').props.children).toBe('false');

    await act(async () => {
      fireEvent.press(getByTestId('enable-local-button'));
    });

    await waitFor(() => {
      expect(getByTestId('local-mode').props.children).toBe('true');
    });
    expect(getByTestId('authenticated').props.children).toBe('true');
    expect(getByTestId('username').props.children).toBe('local');
    expect(mockPersistEnableLocalMode).toHaveBeenCalled();
    unmount();
  });

  it('calls updateLocalSettings when settings change in local mode', async () => {
    mockGetLocalIdentity.mockResolvedValue(localIdentity);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <SettingsConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('local-mode').props.children).toBe('true');
    });

    mockUpdateLocalSettings.mockClear();

    await act(async () => {
      fireEvent.press(getByTestId('change-settings'));
    });

    await waitFor(() => {
      expect(mockUpdateLocalSettings).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'de' }),
      );
    });
    unmount();
  });

  it('does not call updateLocalSettings when settings change in server mode', async () => {
    mockGetStoredSession.mockResolvedValue('token');
    mockAuth.me.mockResolvedValue({ user: mockUser, settings: mockSettings });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <SettingsConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('local-mode').props.children).toBe('false');
    });

    mockUpdateLocalSettings.mockClear();

    await act(async () => {
      fireEvent.press(getByTestId('change-settings'));
    });

    expect(mockUpdateLocalSettings).not.toHaveBeenCalled();
    unmount();
  });

  it('calls updateLocalUser when the profile changes in local mode', async () => {
    mockGetLocalIdentity.mockResolvedValue(localIdentity);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <SettingsConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('local-mode').props.children).toBe('true');
    });

    mockUpdateLocalUser.mockClear();

    await act(async () => {
      fireEvent.press(getByTestId('change-user'));
    });

    await waitFor(() => {
      expect(mockUpdateLocalUser).toHaveBeenCalledWith(
        expect.objectContaining({ first_name: 'Renamed' }),
      );
    });
    unmount();
  });

  it('does not call updateLocalUser when the profile changes in server mode', async () => {
    mockGetStoredSession.mockResolvedValue('token');
    mockAuth.me.mockResolvedValue({ user: mockUser, settings: mockSettings });

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <SettingsConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('local-mode').props.children).toBe('false');
    });

    mockUpdateLocalUser.mockClear();

    await act(async () => {
      fireEvent.press(getByTestId('change-user'));
    });

    expect(mockUpdateLocalUser).not.toHaveBeenCalled();
    unmount();
  });

  it('logout from local mode disables local mode and does not call server logout', async () => {
    mockGetLocalIdentity.mockResolvedValue(localIdentity);

    const { getByTestId, unmount } = render(
      <AuthProvider>
        <LocalModeConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('local-mode').props.children).toBe('true');
    });

    await act(async () => {
      fireEvent.press(getByTestId('logout-button'));
    });

    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('false');
    });
    expect(getByTestId('local-mode').props.children).toBe('false');
    expect(mockDisableLocalMode).toHaveBeenCalled();
    expect(mockAuth.logout).not.toHaveBeenCalled();
    unmount();
  });
});
