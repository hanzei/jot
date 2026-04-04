import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import LoginScreen from '../src/screens/LoginScreen';
import RegisterScreen from '../src/screens/RegisterScreen';
import i18n from '../src/i18n';
import { useAuth } from '../src/store/AuthContext';
import { getBaseUrl, getStoredServerUrl, probeServerReachability, setServerUrl } from '../src/api/client';

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  getBaseUrl: jest.fn(),
  getStoredServerUrl: jest.fn(),
  probeServerReachability: jest.fn(),
  setServerUrl: jest.fn(),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockGetBaseUrl = getBaseUrl as jest.MockedFunction<typeof getBaseUrl>;
const mockGetStoredServerUrl = getStoredServerUrl as jest.MockedFunction<typeof getStoredServerUrl>;
const mockProbeServerReachability = probeServerReachability as jest.MockedFunction<typeof probeServerReachability>;
const mockSetServerUrl = setServerUrl as jest.MockedFunction<typeof setServerUrl>;

describe('Auth first-run server setup flow', () => {
  const mockLogin = jest.fn();
  const mockRegister = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();

    mockUseAuth.mockReturnValue({
      user: null,
      settings: null,
      isAuthenticated: false,
      isLoading: false,
      login: mockLogin,
      register: mockRegister,
      logout: jest.fn(),
      revalidateSession: jest.fn(),
      setUser: jest.fn(),
      setSettings: jest.fn(),
    });

    mockGetBaseUrl.mockReturnValue('http://localhost:8080');
    mockGetStoredServerUrl.mockResolvedValue(null);
    mockProbeServerReachability.mockResolvedValue({
      ok: true,
      canonicalUrl: 'http://localhost:8080',
    });
    mockSetServerUrl.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  function renderLoginScreen() {
    return render(
      <LoginScreen
        navigation={
          {
            navigate: jest.fn(),
          } as never
        }
      />,
    );
  }

  function renderRegisterScreen() {
    return render(
      <RegisterScreen
        navigation={
          {
            goBack: jest.fn(),
          } as never
        }
      />,
    );
  }

  it('shows server setup first when no server is configured', async () => {
    const { getByTestId, queryByTestId } = renderLoginScreen();

    await waitFor(() => {
      expect(queryByTestId('login-server-setup-loading')).toBeNull();
    });

    expect(getByTestId('login-server-setup-step')).toBeTruthy();
    expect(queryByTestId('username-input')).toBeNull();
  });

  it('shows URL validation error for invalid server URL', async () => {
    const { getByTestId, getByText } = renderLoginScreen();

    await waitFor(() => {
      expect(getByTestId('login-server-setup-step')).toBeTruthy();
    });

    fireEvent.changeText(getByTestId('login-server-setup-input'), 'not-a-url');
    fireEvent.press(getByTestId('login-server-setup-submit'));

    expect(getByText(i18n.t('auth.serverUrlProtocol'))).toBeTruthy();
    expect(mockProbeServerReachability).not.toHaveBeenCalled();
  });

  it('shows connection error and allows retry while staying on setup', async () => {
    mockProbeServerReachability
      .mockResolvedValueOnce({
        ok: false,
        reason: 'UNREACHABLE',
      })
      .mockResolvedValueOnce({
        ok: true,
        canonicalUrl: 'http://192.168.1.42:8080',
      });

    const { getByTestId, queryByTestId, getByText } = renderLoginScreen();

    await waitFor(() => {
      expect(getByTestId('login-server-setup-step')).toBeTruthy();
    });

    fireEvent.changeText(getByTestId('login-server-setup-input'), 'http://192.168.1.42:8080');
    fireEvent.press(getByTestId('login-server-setup-submit'));

    await waitFor(() => {
      expect(getByText(i18n.t('auth.serverSetupConnectionFailed'))).toBeTruthy();
    });
    expect(getByTestId('login-server-setup-step')).toBeTruthy();
    expect(queryByTestId('username-input')).toBeNull();

    fireEvent.press(getByTestId('login-server-setup-submit'));

    await waitFor(() => {
      expect(getByTestId('username-input')).toBeTruthy();
    });
    expect(mockSetServerUrl).toHaveBeenCalledWith('http://192.168.1.42:8080');
  });

  it('moves to login form after reachable server and keeps login flow working', async () => {
    const { getByTestId, findByTestId } = renderLoginScreen();

    await waitFor(() => {
      expect(getByTestId('login-server-setup-step')).toBeTruthy();
    });

    fireEvent.changeText(getByTestId('login-server-setup-input'), 'http://localhost:8080');
    fireEvent.press(getByTestId('login-server-setup-submit'));

    await waitFor(() => {
      expect(mockSetServerUrl).toHaveBeenCalledWith('http://localhost:8080');
    });
    expect(await findByTestId('username-input')).toBeTruthy();

    fireEvent.changeText(getByTestId('username-input'), 'alice');
    fireEvent.changeText(getByTestId('password-input'), 'pass1234');
    fireEvent.press(getByTestId('login-button'));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('alice', 'pass1234');
    });
  });

  it('moves to register form after reachable server and keeps registration working', async () => {
    const { getByTestId, findByTestId } = renderRegisterScreen();

    await waitFor(() => {
      expect(getByTestId('register-server-setup-step')).toBeTruthy();
    });

    fireEvent.changeText(getByTestId('register-server-setup-input'), 'http://localhost:8080');
    fireEvent.press(getByTestId('register-server-setup-submit'));

    await waitFor(() => {
      expect(mockSetServerUrl).toHaveBeenCalledWith('http://localhost:8080');
    });
    expect(await findByTestId('username-input')).toBeTruthy();

    fireEvent.changeText(getByTestId('username-input'), 'new_user');
    fireEvent.changeText(getByTestId('password-input'), 'pass1234');
    fireEvent.press(getByTestId('register-button'));

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledWith('new_user', 'pass1234');
    });
  });

  it('shows register setup connection error and retry path', async () => {
    mockProbeServerReachability
      .mockResolvedValueOnce({
        ok: false,
        reason: 'UNREACHABLE',
      })
      .mockResolvedValueOnce({
        ok: true,
        canonicalUrl: 'http://192.168.1.50:8080',
      });

    const { getByTestId, getByText, findByTestId } = renderRegisterScreen();

    await waitFor(() => {
      expect(getByTestId('register-server-setup-step')).toBeTruthy();
    });

    fireEvent.changeText(getByTestId('register-server-setup-input'), 'http://192.168.1.50:8080');
    fireEvent.press(getByTestId('register-server-setup-submit'));

    await waitFor(() => {
      expect(getByText(i18n.t('auth.serverSetupConnectionFailed'))).toBeTruthy();
    });

    fireEvent.press(getByTestId('register-server-setup-submit'));

    await waitFor(() => {
      expect(mockSetServerUrl).toHaveBeenCalledWith('http://192.168.1.50:8080');
    });
    expect(await findByTestId('username-input')).toBeTruthy();
  });

  it('skips setup when a server is already configured', async () => {
    mockGetStoredServerUrl.mockResolvedValue('https://notes.example.com');

    const { getByTestId, queryByTestId } = renderLoginScreen();

    await waitFor(() => {
      expect(getByTestId('username-input')).toBeTruthy();
    });

    expect(queryByTestId('login-server-setup-step')).toBeNull();
    expect(mockProbeServerReachability).not.toHaveBeenCalled();
    expect(mockSetServerUrl).not.toHaveBeenCalled();
  });

  it('shows invalid-api message when server is reachable but incompatible', async () => {
    mockProbeServerReachability.mockResolvedValueOnce({
      ok: false,
      reason: 'AUTH_ENDPOINT_UNAVAILABLE',
    });
    const { getByTestId, getByText } = renderLoginScreen();

    await waitFor(() => {
      expect(getByTestId('login-server-setup-step')).toBeTruthy();
    });

    fireEvent.changeText(getByTestId('login-server-setup-input'), 'http://localhost:8080');
    fireEvent.press(getByTestId('login-server-setup-submit'));

    await waitFor(() => {
      expect(getByText(i18n.t('auth.serverSetupConnectionInvalidServer'))).toBeTruthy();
    });
  });

  it('shows connection error when server activation fails after probe success', async () => {
    mockSetServerUrl.mockRejectedValueOnce(new Error('switch failed'));
    const { getByTestId, getByText } = renderLoginScreen();

    await waitFor(() => {
      expect(getByTestId('login-server-setup-step')).toBeTruthy();
    });

    fireEvent.changeText(getByTestId('login-server-setup-input'), 'http://localhost:8080');
    fireEvent.press(getByTestId('login-server-setup-submit'));

    await waitFor(() => {
      expect(getByText(i18n.t('auth.serverSetupConnectionFailed'))).toBeTruthy();
    });
  });
});
