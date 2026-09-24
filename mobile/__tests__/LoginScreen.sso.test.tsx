import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ServerConfig } from '@jot/shared';
import LoginScreen from '../src/screens/LoginScreen';
import { useAuth } from '../src/store/AuthContext';
import { useServerConfig } from '../src/hooks/useServerConfig';
import { SsoFlowError } from '../src/store/oidcFlow';
import type { AuthStackParamList } from '../src/navigation/AuthStack';

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/hooks/useServerConfig', () => ({
  useServerConfig: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  getStoredServerUrl: jest.fn().mockResolvedValue('https://one.example.com'),
  getBaseUrl: jest.fn(() => 'https://one.example.com'),
  probeServerReachability: jest.fn(),
  setServerUrl: jest.fn(),
  switchActiveServer: jest.fn(),
}));

jest.mock('../src/store/serverAccounts', () => ({
  listServers: jest.fn().mockResolvedValue([]),
  getActiveServer: jest.fn().mockResolvedValue(null),
  removeServer: jest.fn(),
  renameServer: jest.fn(),
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.provider ? `${key}:${String(options.provider)}` : key,
  }),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUseServerConfig = useServerConfig as jest.MockedFunction<typeof useServerConfig>;

const baseConfig: ServerConfig = { registration_enabled: true, password_min_length: 10, upload_max_bytes: 1024 };
const mixedMode: ServerConfig = { ...baseConfig, sso: { enabled: true, provider_name: 'Keycloak', local_login_enabled: true } };
const ssoOnly: ServerConfig = { ...baseConfig, sso: { enabled: true, provider_name: 'Keycloak', local_login_enabled: false } };

const mockLoginWithSso = jest.fn();
const mockLogin = jest.fn();
const mockEnableLocalMode = jest.fn();

async function renderLogin(config: ServerConfig) {
  mockUseServerConfig.mockReturnValue(config);
  const navigation = { navigate: jest.fn() } as unknown as NativeStackNavigationProp<AuthStackParamList, 'Login'>;
  const utils = await render(<LoginScreen navigation={navigation} />);
  // ServerSetupGate resolves the stored server before rendering the form.
  await waitFor(() => expect(utils.getByTestId('use-local-mode-button')).toBeTruthy());
  return utils;
}

describe('LoginScreen SSO', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({
      login: mockLogin,
      loginWithSso: mockLoginWithSso,
      enableLocalMode: mockEnableLocalMode,
      sessionEndedReason: null,
      clearSessionEndedReason: jest.fn(),
    } as unknown as ReturnType<typeof useAuth>);
  });

  it.each([
    ['no sso block (pre-SSO server)', baseConfig],
    ['sso disabled', { ...baseConfig, sso: { enabled: false, provider_name: 'SSO', local_login_enabled: true } }],
  ])('looks exactly as before with %s', async (_label, config) => {
    const { getByTestId, queryByTestId } = await renderLogin(config);

    await waitFor(() => expect(getByTestId('login-button')).toBeTruthy());
    expect(getByTestId('username-input')).toBeTruthy();
    expect(getByTestId('password-input')).toBeTruthy();
    expect(getByTestId('create-account-link')).toBeTruthy();
    expect(queryByTestId('login-sso-button')).toBeNull();
    expect(queryByTestId('login-sso-divider')).toBeNull();
  });

  it('shows the provider button alongside the password form in mixed mode', async () => {
    const { getByTestId } = await renderLogin(mixedMode);

    await waitFor(() => expect(getByTestId('login-sso-button')).toBeTruthy());
    expect(getByTestId('login-sso-button')).toHaveTextContent('auth.ssoSignInWith:Keycloak');
    expect(getByTestId('login-sso-divider')).toBeTruthy();
    expect(getByTestId('username-input')).toBeTruthy();
    expect(getByTestId('login-button')).toBeTruthy();
    expect(getByTestId('create-account-link')).toBeTruthy();
  });

  it('hides the password form and registration when SSO is the only way in', async () => {
    const { getByTestId, queryByTestId } = await renderLogin(ssoOnly);

    await waitFor(() => expect(getByTestId('login-sso-button')).toBeTruthy());
    expect(queryByTestId('username-input')).toBeNull();
    expect(queryByTestId('password-input')).toBeNull();
    expect(queryByTestId('login-button')).toBeNull();
    expect(queryByTestId('create-account-link')).toBeNull();
    expect(queryByTestId('login-sso-divider')).toBeNull();
    // Local mode stays available; it does not involve the server.
    expect(getByTestId('use-local-mode-button')).toBeTruthy();
  });

  it('falls back to "SSO" when the server sends no provider name', async () => {
    const { getByTestId } = await renderLogin({ ...baseConfig, sso: { enabled: true, provider_name: '', local_login_enabled: true } });

    await waitFor(() => expect(getByTestId('login-sso-button')).toHaveTextContent('auth.ssoSignInWith:SSO'));
  });

  it('shows a pending state while the flow runs and blocks both sign-in paths', async () => {
    let finish: (value: 'signedIn' | 'cancelled') => void = () => {};
    mockLoginWithSso.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { getByTestId } = await renderLogin(mixedMode);
    await waitFor(() => expect(getByTestId('login-sso-button')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('login-sso-button'));
    });

    expect(mockLoginWithSso).toHaveBeenCalledTimes(1);
    expect(getByTestId('login-sso-button').props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(getByTestId('login-button').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));

    await act(async () => {
      finish('signedIn');
    });
    expect(getByTestId('login-sso-button').props.accessibilityState).toEqual({ disabled: false, busy: false });
  });

  it('blocks entering local mode while an SSO sign-in is pending', async () => {
    mockLoginWithSso.mockImplementation(() => new Promise(() => {}));
    const { getByTestId } = await renderLogin(mixedMode);
    await waitFor(() => expect(getByTestId('login-sso-button')).toBeTruthy());
    await waitFor(() => expect(getByTestId('use-local-mode-button').props.accessibilityState.disabled).toBe(false));

    await act(async () => {
      fireEvent.press(getByTestId('login-sso-button'));
    });

    expect(getByTestId('use-local-mode-button').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
  });

  it('blocks both server sign-ins while local mode is being entered', async () => {
    mockEnableLocalMode.mockImplementation(() => new Promise(() => {}));
    const { getByTestId } = await renderLogin(mixedMode);
    await waitFor(() => expect(getByTestId('use-local-mode-button').props.accessibilityState.disabled).toBe(false));
    // A configured server makes local mode confirm first; accept it.
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.[1]?.onPress?.();
    });

    await act(async () => {
      fireEvent.press(getByTestId('use-local-mode-button'));
    });

    expect(mockEnableLocalMode).toHaveBeenCalled();
    expect(getByTestId('login-sso-button').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    expect(getByTestId('login-button').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    alertSpy.mockRestore();
  });

  it('returns quietly when the user dismisses the browser sheet', async () => {
    mockLoginWithSso.mockResolvedValue('cancelled');
    const { getByTestId, queryByRole } = await renderLogin(ssoOnly);
    await waitFor(() => expect(getByTestId('login-sso-button')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('login-sso-button'));
    });

    expect(queryByRole('alert')).toBeNull();
  });

  it.each([
    ['a callback error', new SsoFlowError('auth.ssoCancelled'), 'auth.ssoCancelled'],
    ['an exchange 400', { response: { status: 400, data: 'invalid or expired code' } }, 'auth.ssoFailed'],
    ['a network failure', new Error('Network Error'), 'auth.unableToConnect'],
  ])('shows a terminal error for %s', async (_label, error, message) => {
    mockLoginWithSso.mockRejectedValue(error);
    const { getByTestId, findByRole } = await renderLogin(ssoOnly);
    await waitFor(() => expect(getByTestId('login-sso-button')).toBeTruthy());

    await act(async () => {
      fireEvent.press(getByTestId('login-sso-button'));
    });

    expect(await findByRole('alert')).toHaveTextContent(message);
    expect(mockLoginWithSso).toHaveBeenCalledTimes(1);
  });
});
