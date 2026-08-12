import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import LoginScreen from '../src/screens/LoginScreen';
import RegisterScreen from '../src/screens/RegisterScreen';
import i18n from '../src/i18n';
import { useAuth } from '../src/store/AuthContext';
import { getBaseUrl, getStoredServerUrl, probeServerReachability, setServerUrl } from '../src/api/client';
import { VALIDATION } from '@jot/shared';

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  getBaseUrl: jest.fn(),
  getStoredServerUrl: jest.fn(),
  getActiveServerId: jest.fn(),
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
  const mockEnableLocalMode = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();

    mockUseAuth.mockReturnValue({
      user: null,
      settings: null,
      isAuthenticated: false,
      isLoading: false,
      isLocalMode: false,
      revalidationFailed: false,
      sessionEndedReason: null,
      clearSessionEndedReason: jest.fn(),
      login: mockLogin,
      register: mockRegister,
      enableLocalMode: mockEnableLocalMode,
      logout: jest.fn(),
      clearAuth: jest.fn(),
      revalidateSession: jest.fn(),
      setUser: jest.fn(),
      setSettings: jest.fn(),
      completeServerUpgrade: jest.fn(),
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
      expect(getByTestId('login-server-setup-step')).toBeTruthy();
    });

    expect(queryByTestId('username-input')).toBeNull();
  });

  it('shows URL validation error for invalid server URL', async () => {
    const { getByTestId, getByText } = renderLoginScreen();

    await waitFor(() => {
      expect(getByTestId('login-server-setup-step')).toBeTruthy();
    });

    fireEvent.changeText(getByTestId('login-server-setup-input'), 'not-a-url');
    fireEvent.press(getByTestId('login-server-setup-submit'));

    await waitFor(() => {
      expect(getByText(i18n.t('auth.serverUrlProtocol'))).toBeTruthy();
    });
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
    const validPassword = 'p'.repeat(VALIDATION.PASSWORD_MIN_LENGTH);

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
    fireEvent.changeText(getByTestId('password-input'), validPassword);

    fireEvent.press(getByTestId('register-button'));

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledWith('new_user', validPassword);
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
    expect(mockSetServerUrl).not.toHaveBeenCalled();
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
    expect(mockProbeServerReachability).toHaveBeenCalledWith('http://localhost:8080');
    expect(mockSetServerUrl).toHaveBeenCalledWith('http://localhost:8080');
  });

  it('enters local mode directly when no server is configured', async () => {
    // Fresh install: local mode is a first-class choice, so no confirmation.
    mockGetStoredServerUrl.mockResolvedValue(null);
    const alertSpy = jest.spyOn(Alert, 'alert');
    const { getByTestId } = renderLoginScreen();

    await waitFor(() => {
      expect(getByTestId('use-local-mode-button')).toBeTruthy();
    });
    await act(async () => {});

    fireEvent.press(getByTestId('use-local-mode-button'));

    await waitFor(() => {
      expect(mockEnableLocalMode).toHaveBeenCalledTimes(1);
    });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('confirms before entering local mode when a server is already configured', async () => {
    // Session-expiry re-login: a stray tap must not strand the user in an empty
    // on-device notebook away from their server notes.
    mockGetStoredServerUrl.mockResolvedValue('https://notes.example.com');
    const alertSpy = jest.spyOn(Alert, 'alert');
    const { getByTestId, findByTestId } = renderLoginScreen();

    await findByTestId('username-input');
    // Flush the effect that reads the stored server URL into hasConfiguredServer.
    await act(async () => {});

    fireEvent.press(getByTestId('use-local-mode-button'));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(mockEnableLocalMode).not.toHaveBeenCalled();

    // Invoke the confirm action from the alert's button list.
    const buttons = alertSpy.mock.calls[0]![2] as { text?: string; onPress?: () => void }[];
    const confirmButton = buttons.find((b) => b.text === i18n.t('auth.localModeLink'));
    expect(confirmButton).toBeDefined();
    await act(async () => {
      confirmButton?.onPress?.();
    });

    await waitFor(() => {
      expect(mockEnableLocalMode).toHaveBeenCalledTimes(1);
    });
  });

  it('does not show a session-ended message by default', async () => {
    mockGetStoredServerUrl.mockResolvedValue('https://notes.example.com');
    const { findByTestId, queryByTestId } = renderLoginScreen();

    await findByTestId('username-input');
    expect(queryByTestId('session-ended-banner')).toBeNull();
  });

  it('shows a session-ended message after a 401-driven logout and clears it on dismiss (#853)', async () => {
    const mockClearSessionEndedReason = jest.fn();
    mockUseAuth.mockReturnValue({
      user: null,
      settings: null,
      isAuthenticated: false,
      isLoading: false,
      isLocalMode: false,
      revalidationFailed: false,
      sessionEndedReason: 'unauthorized',
      clearSessionEndedReason: mockClearSessionEndedReason,
      login: mockLogin,
      register: mockRegister,
      enableLocalMode: mockEnableLocalMode,
      logout: jest.fn(),
      clearAuth: jest.fn(),
      revalidateSession: jest.fn(),
      setUser: jest.fn(),
      setSettings: jest.fn(),
      completeServerUpgrade: jest.fn(),
    });

    const { getByTestId, queryByTestId, rerender } = renderLoginScreen();

    await waitFor(() => {
      expect(getByTestId('session-ended-banner')).toBeTruthy();
    });
    expect(getByTestId('session-ended-banner')).toHaveTextContent(i18n.t('auth.sessionEndedMessage'), { exact: false });

    fireEvent.press(getByTestId('session-ended-dismiss'));
    expect(mockClearSessionEndedReason).toHaveBeenCalledTimes(1);

    // The mock is stateless (dismiss doesn't flip sessionEndedReason back to
    // null on its own), so rerender with the reason cleared, the way
    // AuthContext would after a real dismiss.
    mockUseAuth.mockReturnValue({
      user: null,
      settings: null,
      isAuthenticated: false,
      isLoading: false,
      isLocalMode: false,
      revalidationFailed: false,
      sessionEndedReason: null,
      clearSessionEndedReason: mockClearSessionEndedReason,
      login: mockLogin,
      register: mockRegister,
      enableLocalMode: mockEnableLocalMode,
      logout: jest.fn(),
      clearAuth: jest.fn(),
      revalidateSession: jest.fn(),
      setUser: jest.fn(),
      setSettings: jest.fn(),
      completeServerUpgrade: jest.fn(),
    });
    rerender(<LoginScreen navigation={{ navigate: jest.fn() } as never} />);
    expect(queryByTestId('session-ended-banner')).toBeNull();
  });
});
