import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import ServerPickerModal from '../src/components/drawer/ServerPickerModal';
import { useAuth } from '../src/store/AuthContext';
import { switchActiveServer } from '../src/api/client';
import { getActiveServer, listServers, removeServer, renameServer } from '../src/store/serverAccounts';

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  switchActiveServer: jest.fn(),
  getBaseUrl: jest.fn(() => 'https://one.example.com'),
  getStoredServerUrl: jest.fn().mockResolvedValue('https://one.example.com'),
  probeServerReachability: jest.fn(),
  setServerUrl: jest.fn(),
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
      overlay: 'rgba(0,0,0,0.4)',
      surface: '#fff',
      background: '#fff',
      borderLight: '#eee',
      border: '#ddd',
      text: '#111',
      textSecondary: '#666',
      placeholder: '#999',
      primary: '#06c',
      icon: '#444',
      error: '#c00',
      inputBackground: '#fff',
      inputBorder: '#ddd',
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
const mockSwitchActiveServer = switchActiveServer as jest.MockedFunction<typeof switchActiveServer>;
const mockListServers = listServers as jest.MockedFunction<typeof listServers>;
const mockGetActiveServer = getActiveServer as jest.MockedFunction<typeof getActiveServer>;
const mockRemoveServer = removeServer as jest.MockedFunction<typeof removeServer>;
const mockRenameServer = renameServer as jest.MockedFunction<typeof renameServer>;

const serverOne = {
  serverId: 'server-one',
  serverUrl: 'https://one.example.com',
  displayName: 'Work',
  lastUsedAt: '2026-08-08T10:00:00.000Z',
};
const serverTwo = {
  serverId: 'server-two',
  serverUrl: 'https://two.example.com',
  lastUsedAt: '2026-08-07T10:00:00.000Z',
};

const revalidateSession = jest.fn();
const clearAuth = jest.fn();

function renderPicker(overrides: Partial<React.ComponentProps<typeof ServerPickerModal>> = {}) {
  const props = {
    visible: true,
    onClose: jest.fn(),
    onSwitched: jest.fn(),
    ...overrides,
  };
  return { ...render(<ServerPickerModal {...props} />), props };
}

describe('ServerPickerModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockUseAuth.mockReturnValue({ clearAuth, revalidateSession } as unknown as ReturnType<typeof useAuth>);
    mockListServers.mockResolvedValue([serverOne, serverTwo]);
    mockGetActiveServer.mockResolvedValue(serverOne);
    revalidateSession.mockResolvedValue(true);
  });

  it('lists every registered server once opened', async () => {
    const { getByTestId } = renderPicker();

    await waitFor(() => expect(getByTestId('server-picker-row-server-one')).toBeTruthy());
    expect(getByTestId('server-picker-row-server-two')).toBeTruthy();
    // Falls back to the URL when the server has no display name.
    expect(getByTestId('server-picker-modal')).toBeTruthy();
  });

  it('does not read the registry while hidden', () => {
    renderPicker({ visible: false });
    expect(mockListServers).not.toHaveBeenCalled();
  });

  it('switches to another server and reports the resulting session as valid', async () => {
    mockSwitchActiveServer.mockResolvedValue(true);
    const { getByTestId, props } = renderPicker();
    await waitFor(() => expect(getByTestId('server-picker-row-server-two')).toBeTruthy());

    fireEvent.press(getByTestId('server-picker-row-server-two'));

    await waitFor(() => expect(props.onSwitched).toHaveBeenCalledWith(true));
    expect(mockSwitchActiveServer).toHaveBeenCalledWith('server-two');
    expect(revalidateSession).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('switches but reports an invalid session, prompting a fresh sign-in', async () => {
    mockSwitchActiveServer.mockResolvedValue(true);
    revalidateSession.mockResolvedValue(false);
    const { getByTestId, props } = renderPicker();
    await waitFor(() => expect(getByTestId('server-picker-row-server-two')).toBeTruthy());

    fireEvent.press(getByTestId('server-picker-row-server-two'));

    await waitFor(() => expect(props.onSwitched).toHaveBeenCalledWith(false));
    expect(props.onClose).toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'serverPicker.sessionExpiredTitle',
      'serverPicker.sessionExpiredMessage',
    );
  });

  it('keeps the picker open when the switch itself fails', async () => {
    mockSwitchActiveServer.mockResolvedValue(false);
    const { getByTestId, props } = renderPicker();
    await waitFor(() => expect(getByTestId('server-picker-row-server-two')).toBeTruthy());

    fireEvent.press(getByTestId('server-picker-row-server-two'));

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('common.error', 'serverPicker.switchFailed'));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onSwitched).not.toHaveBeenCalled();
    expect(revalidateSession).not.toHaveBeenCalled();
  });

  it('ignores a tap on the server that is already active', async () => {
    const { getByTestId, props } = renderPicker();
    await waitFor(() => expect(getByTestId('server-picker-row-server-one')).toBeTruthy());

    fireEvent.press(getByTestId('server-picker-row-server-one'));

    expect(mockSwitchActiveServer).not.toHaveBeenCalled();
    expect(props.onSwitched).not.toHaveBeenCalled();
  });

  it('renames a server in place and returns to the list', async () => {
    mockRenameServer.mockResolvedValue(true);
    const { getByTestId, queryByTestId } = renderPicker();
    await waitFor(() => expect(getByTestId('server-picker-rename-server-two')).toBeTruthy());

    fireEvent.press(getByTestId('server-picker-rename-server-two'));
    fireEvent.changeText(getByTestId('server-rename-input'), '  Home  ');
    fireEvent.press(getByTestId('server-rename-submit'));

    await waitFor(() => expect(mockRenameServer).toHaveBeenCalledWith('server-two', 'Home'));
    await waitFor(() => expect(queryByTestId('server-picker-modal')).toBeTruthy());
    expect(queryByTestId('server-rename-input')).toBeNull();
  });

  it('signs the user out once the last server is removed', async () => {
    mockListServers.mockResolvedValue([serverOne]);
    // Empty the registry as part of the removal rather than by call ordering, so
    // the test doesn't depend on how many times the component reloads.
    mockRemoveServer.mockImplementation(async () => {
      mockListServers.mockResolvedValue([]);
      mockGetActiveServer.mockResolvedValue(null);
      return true;
    });
    const { getByTestId, props } = renderPicker();
    await waitFor(() => expect(getByTestId('server-picker-delete-server-one')).toBeTruthy());

    fireEvent.press(getByTestId('server-picker-delete-server-one'));
    // Confirm through the destructive button in the Alert.
    const confirmButton = (Alert.alert as jest.Mock).mock.calls[0][2][1];
    await act(async () => {
      await confirmButton.onPress();
    });

    expect(mockRemoveServer).toHaveBeenCalledWith('server-one');
    await waitFor(() => expect(clearAuth).toHaveBeenCalled());
    expect(props.onClose).toHaveBeenCalled();
  });
});
