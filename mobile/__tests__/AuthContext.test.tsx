import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { AuthProvider, useAuth } from '../src/store/AuthContext';
import { auth, getStoredSession } from '../src/api/client';

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

function TestConsumer() {
  const { user, isAuthenticated, isLoading } = useAuth();
  return (
    <>
      <Text testID="loading">{String(isLoading)}</Text>
      <Text testID="authenticated">{String(isAuthenticated)}</Text>
      <Text testID="username">{user?.username || 'none'}</Text>
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

    // Initially loading
    expect(getByTestId('loading').props.children).toBe('true');

    await waitFor(() => {
      expect(getByTestId('loading').props.children).toBe('false');
    });

    expect(getByTestId('authenticated').props.children).toBe('false');
    expect(getByTestId('username').props.children).toBe('none');
  });

  it('restores session on mount when token exists', async () => {
    mockGetStoredSession.mockResolvedValue('existing-token');
    mockAuth.me.mockResolvedValue({
      user: { id: '1', username: 'restored', first_name: '', last_name: '', role: 'user', has_profile_icon: false, created_at: '', updated_at: '' },
      settings: { user_id: '1', language: 'en', theme: 'system', updated_at: '' },
    });

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
    mockAuth.login.mockResolvedValue({
      user: { id: '2', username: 'testuser', first_name: '', last_name: '', role: 'user', has_profile_icon: false, created_at: '', updated_at: '' },
      settings: { user_id: '2', language: 'en', theme: 'system', updated_at: '' },
    });

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
});
