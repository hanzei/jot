import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import LoginScreen from '../src/screens/LoginScreen';
import { useAuth } from '../src/store/AuthContext';
import { getActiveServer, listServers } from '../src/store/serverAccounts';
import type { AuthStackParamList } from '../src/navigation/AuthStack';

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  getStoredServerUrl: jest.fn().mockResolvedValue('https://one.example.com'),
  getBaseUrl: jest.fn(() => 'https://one.example.com'),
  probeServerReachability: jest.fn(),
  setServerUrl: jest.fn(),
  switchActiveServer: jest.fn(),
}));

jest.mock('../src/store/serverAccounts', () => ({
  listServers: jest.fn(),
  getActiveServer: jest.fn(),
  removeServer: jest.fn(),
  renameServer: jest.fn(),
}));

jest.mock('../src/theme/ThemeContext', () => ({
  __esModule: true,
  useTheme: () => ({
    colors: {
      surface: '#fff',
      background: '#fff',
      overlay: 'rgba(0,0,0,0.4)',
      text: '#111',
      textSecondary: '#666',
      placeholder: '#999',
      primary: '#06c',
      icon: '#444',
      error: '#c00',
      border: '#ddd',
      borderLight: '#eee',
      inputBackground: '#fff',
      inputBorder: '#ddd',
      warning: '#ffd',
      warningBorder: '#ec9',
      warningText: '#630',
    },
  }),
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockListServers = listServers as jest.MockedFunction<typeof listServers>;
const mockGetActiveServer = getActiveServer as jest.MockedFunction<typeof getActiveServer>;

const workServer = {
  serverId: 'server-one',
  serverUrl: 'https://one.example.com',
  displayName: 'Work',
  lastUsedAt: '2026-08-08T10:00:00.000Z',
};
const unnamedServer = {
  serverId: 'server-two',
  serverUrl: 'https://two.example.com',
  lastUsedAt: '2026-08-07T10:00:00.000Z',
};

async function renderLogin() {
  const navigation = { navigate: jest.fn() } as unknown as NativeStackNavigationProp<AuthStackParamList, 'Login'>;
  return await render(<LoginScreen navigation={navigation} />);
}

describe('LoginScreen server switcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({
      login: jest.fn(),
      enableLocalMode: jest.fn(),
      sessionEndedReason: null,
      clearSessionEndedReason: jest.fn(),
      clearAuth: jest.fn(),
      revalidateSession: jest.fn(),
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('names the server it will sign in to', async () => {
    mockListServers.mockResolvedValue([workServer, unnamedServer]);
    mockGetActiveServer.mockResolvedValue(workServer);

    const { getByTestId } = await renderLogin();

    await waitFor(() => expect(getByTestId('login-server-switcher-name')).toBeTruthy());
    expect(getByTestId('login-server-switcher-name')).toHaveTextContent('Work');
  });

  it('falls back to the URL for a server with no display name', async () => {
    mockListServers.mockResolvedValue([unnamedServer]);
    mockGetActiveServer.mockResolvedValue(unnamedServer);

    const { getByTestId } = await renderLogin();

    await waitFor(() => expect(getByTestId('login-server-switcher-name')).toHaveTextContent('https://two.example.com'));
  });

  it('hides the switcher entirely when no server is registered yet', async () => {
    mockListServers.mockResolvedValue([]);
    mockGetActiveServer.mockResolvedValue(null);

    const { queryByTestId, getByTestId } = await renderLogin();

    await waitFor(() => expect(getByTestId('login-button')).toBeTruthy());
    expect(queryByTestId('login-server-switcher')).toBeNull();
  });

  it('opens the shared server picker when tapped', async () => {
    mockListServers.mockResolvedValue([workServer, unnamedServer]);
    mockGetActiveServer.mockResolvedValue(workServer);

    const { getByTestId, queryByTestId } = await renderLogin();
    await waitFor(() => expect(getByTestId('login-server-switcher')).toBeTruthy());
    expect(queryByTestId('server-picker-modal')).toBeNull();

    await fireEvent.press(getByTestId('login-server-switcher'));

    await waitFor(() => expect(getByTestId('server-picker-modal')).toBeTruthy());
    expect(getByTestId('server-picker-row-server-two')).toBeTruthy();
  });
});
