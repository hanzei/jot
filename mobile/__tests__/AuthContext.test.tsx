import React from 'react';
import { render, waitFor, act, fireEvent, cleanup } from '@testing-library/react-native';
import { Text, TouchableOpacity } from 'react-native';
import { AuthProvider, useAuth } from '../src/store/AuthContext';
import { auth, getStoredSession, setOnUnauthorized, clearStoredSession, cacheAuthProfile, getCachedAuthProfile, clearCachedProfile } from '../src/api/client';

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

function TestConsumer() {
  const { user, isAuthenticated, isLoading, logout } = useAuth();
  return (
    <>
      <Text testID="loading">{String(isLoading)}</Text>
      <Text testID="authenticated">{String(isAuthenticated)}</Text>
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

const mockUser = { id: '1', username: 'testuser', first_name: '', last_name: '', role: 'user', has_profile_icon: false, created_at: '', updated_at: '' };
const mockSettings = { user_id: '1', language: 'en', theme: 'system' as const, updated_at: '' };

describe('AuthContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStoredSession.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
  });

  it('starts with isLoading true and no user', async () => {
    const { getByTestId, unmount } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    expect(getByTestId('loading').props.children).toBe('true');

    // Flush the async restoreSession effect (resolved getStoredSession promise)
    await act(async () => {});

    expect(getByTestId('loading').props.children).toBe('false');
    expect(getByTestId('authenticated').props.children).toBe('false');
    expect(getByTestId('username').props.children).toBe('none');
    unmount();
  });

  it('restores session on mount when token exists', async () => {
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
});
