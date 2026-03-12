import React from 'react';
import { render, waitFor, act, fireEvent } from '@testing-library/react-native';
import { Text, TouchableOpacity } from 'react-native';
import { AuthProvider, useAuth } from '../src/store/AuthContext';
import { auth, getStoredSession, setOnUnauthorized } from '../src/api/client';

jest.mock('../src/api/client', () => ({
  auth: {
    login: jest.fn(),
    register: jest.fn(),
    logout: jest.fn(),
    me: jest.fn(),
  },
  getStoredSession: jest.fn(),
  clearStoredSession: jest.fn(),
  setOnUnauthorized: jest.fn(),
}));

const mockAuth = auth as {
  login: jest.Mock;
  register: jest.Mock;
  logout: jest.Mock;
  me: jest.Mock;
};
const mockGetStoredSession = getStoredSession as jest.Mock;
const mockSetOnUnauthorized = setOnUnauthorized as jest.Mock;

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

  it('starts with isLoading true and no user', async () => {
    const { getByTestId } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    expect(getByTestId('loading').props.children).toBe('true');

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('false');
    expect(getByTestId('username').props.children).toBe('none');
  });

  it('restores session on mount when token exists', async () => {
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockAuth.me.mockResolvedValue({ user: { ...mockUser, username: 'restored' }, settings: mockSettings });

    const { getByTestId } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('true');
    expect(getByTestId('username').props.children).toBe('restored');
  });

  it('login sets user on success', async () => {
    mockAuth.login.mockResolvedValue({ user: mockUser, settings: mockSettings });

    const { getByTestId } = render(
      <AuthProvider>
        <LoginTrigger />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('username').props.children).toBe('testuser');
    });

    expect(mockAuth.login).toHaveBeenCalledWith({ username: 'testuser', password: 'password' });
  });

  it('logout clears user state', async () => {
    mockGetStoredSession.mockResolvedValue('token');
    mockAuth.me.mockResolvedValue({ user: mockUser, settings: mockSettings });
    mockAuth.logout.mockResolvedValue(undefined);

    const { getByTestId } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    // Wait for session restore to set user
    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('true');
    });

    // Trigger logout via the button
    await act(async () => {
      fireEvent.press(getByTestId('logout-button'));
    });

    expect(mockAuth.logout).toHaveBeenCalled();
    expect(getByTestId('authenticated').props.children).toBe('false');
    expect(getByTestId('username').props.children).toBe('none');
  });

  it('logout clears state even when auth.logout rejects', async () => {
    mockGetStoredSession.mockResolvedValue('token');
    mockAuth.me.mockResolvedValue({ user: mockUser, settings: mockSettings });
    mockAuth.logout.mockRejectedValue(new Error('network error'));

    const { getByTestId } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    // Wait for session restore
    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('true');
    });

    // Trigger logout - should clear state despite rejection
    await act(async () => {
      fireEvent.press(getByTestId('logout-button'));
    });

    expect(mockAuth.logout).toHaveBeenCalled();
    expect(getByTestId('authenticated').props.children).toBe('false');
    expect(getByTestId('username').props.children).toBe('none');
  });

  it('unauthorized callback clears auth state', async () => {
    let unauthorizedCb: (() => void) | null = null;
    mockSetOnUnauthorized.mockImplementation((cb: (() => void) | null) => {
      unauthorizedCb = cb;
    });

    mockGetStoredSession.mockResolvedValue('token');
    mockAuth.me.mockResolvedValue({ user: mockUser, settings: mockSettings });

    const { getByTestId } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(getByTestId('authenticated').props.children).toBe('true');
    });

    // Simulate a 401 from the interceptor
    await act(async () => {
      unauthorizedCb?.();
    });

    expect(getByTestId('authenticated').props.children).toBe('false');
    expect(getByTestId('username').props.children).toBe('none');
  });
});
