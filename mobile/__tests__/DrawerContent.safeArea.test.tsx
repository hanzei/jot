import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor, act } from '@testing-library/react-native';
import type { DrawerContentComponentProps } from '@react-navigation/drawer';
import DrawerContent from '../src/components/DrawerContent';
import { ConfirmContext } from '../src/hooks/useConfirm';
import type { Label } from '@jot/shared';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const mockSwitchActiveServer = jest.fn();
const mockRevalidateSession = jest.fn(async () => true);
const mockListServers = jest.fn();
const mockGetActiveServer = jest.fn();
const mockAddServer = jest.fn();
const mockLabelsData: Label[] = [];
const mockLabelCountsData: Record<string, number> = {};
const mockCreateLabelMutateAsync = jest.fn();
const mockRenameLabelMutateAsync = jest.fn();
const mockDeleteLabelMutateAsync = jest.fn();
const mockUserAvatar = jest.fn();
let mockHasProfileIcon = true;

jest.mock('../src/store/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      username: 'alice',
      first_name: 'Alice',
      last_name: 'Smith',
      role: 'user',
      has_profile_icon: mockHasProfileIcon,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    logout: jest.fn(),
    clearAuth: jest.fn(),
    revalidateSession: mockRevalidateSession,
  }),
}));

jest.mock('../src/components/UserAvatar', () => ({
  __esModule: true,
  default: (props: unknown) => {
    const ReactLocal = jest.requireActual('react');
    const { Text } = jest.requireActual('react-native');
    mockUserAvatar(props);
    return ReactLocal.createElement(Text, { testID: 'drawer-user-avatar' });
  },
}));

jest.mock('../src/hooks/useLabels', () => {
  const ReactActual = jest.requireActual('react');
  // Mirrors react-query's isPending: true only while the mock's promise is
  // in flight, so tests can drive a real pending -> resolved transition with a
  // deferred promise instead of a static flag (#698).
  function useTrackedMutation(mutateAsyncMock: (...args: unknown[]) => Promise<unknown>) {
    const [isPending, setIsPending] = ReactActual.useState(false);
    const mutateAsync = ReactActual.useCallback(async (...args: unknown[]) => {
      setIsPending(true);
      try {
        return await mutateAsyncMock(...args);
      } finally {
        setIsPending(false);
      }
    }, [mutateAsyncMock]);
    return { mutateAsync, isPending };
  }
  return {
    useLabels: () => ({ data: mockLabelsData }),
    useLabelCounts: () => ({ data: mockLabelCountsData }),
    useCreateLabel: () => useTrackedMutation(mockCreateLabelMutateAsync),
    useRenameLabel: () => useTrackedMutation(mockRenameLabelMutateAsync),
    useDeleteLabel: () => useTrackedMutation(mockDeleteLabelMutateAsync),
  };
});

jest.mock('../src/theme/ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      surface: '#ffffff',
      primary: '#2563eb',
      text: '#111827',
      textSecondary: '#6b7280',
      divider: '#e5e7eb',
      primaryLight: '#dbeafe',
      icon: '#374151',
      error: '#ef4444',
      overlay: 'rgba(0,0,0,0.5)',
      borderLight: '#e5e7eb',
      border: '#d1d5db',
      background: '#f9fafb',
      placeholder: '#9ca3af',
    },
  }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('@react-navigation/native', () => ({
  CommonActions: {
    navigate: jest.fn((payload) => payload),
  },
}));

jest.mock('../src/api/client', () => ({
  switchActiveServer: (...args: unknown[]) => mockSwitchActiveServer(...args),
  getBaseUrl: jest.fn(() => 'http://localhost:8080'),
  getStoredServerUrl: jest.fn(async () => null),
  probeServerReachability: jest.fn(async () => ({ ok: true, canonicalUrl: 'http://localhost:8080' })),
  setServerUrl: jest.fn(async () => undefined),
}));

jest.mock('../src/store/serverAccounts', () => ({
  listServers: (...args: unknown[]) => mockListServers(...args),
  getActiveServer: (...args: unknown[]) => mockGetActiveServer(...args),
  addServer: (...args: unknown[]) => mockAddServer(...args),
}));

jest.mock('@react-navigation/drawer', () => {
  const { View } = jest.requireActual('react-native');
  const ReactLocal = jest.requireActual('react');
  return {
    DrawerContentScrollView: (props: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactLocal.createElement(View, { testID: 'drawer-scroll-view', ...props }, props.children),
  };
});

const makeProps = (): DrawerContentComponentProps => ({
  state: {
    index: 0,
    key: 'drawer-key',
    routeNames: ['Notes', 'MyTasks', 'Archived', 'Trash'],
    routes: [{ key: 'notes-key', name: 'Notes' }],
    stale: false,
    type: 'drawer',
    history: [],
  },
  navigation: {
    navigate: jest.fn(),
    closeDrawer: jest.fn(),
    dispatch: jest.fn(),
  },
  descriptors: {},
  progress: {},
} as unknown as DrawerContentComponentProps);

describe('DrawerContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLabelsData.length = 0;
    Object.keys(mockLabelCountsData).forEach((key) => delete mockLabelCountsData[key]);
    mockHasProfileIcon = true;
    mockRevalidateSession.mockResolvedValue(true);
    mockListServers.mockResolvedValue([]);
    mockGetActiveServer.mockResolvedValue(null);
    mockAddServer.mockResolvedValue({ success: true, serverId: 'srv_new' });
    mockSwitchActiveServer.mockResolvedValue(true);
    mockCreateLabelMutateAsync.mockResolvedValue({
      id: 'label-new',
      user_id: 'user-1',
      name: 'New label',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('applies top inset padding to drawer scroll content', () => {
    const props = makeProps();

    const { getByTestId } = render(<DrawerContent {...props} />);
    const scrollView = getByTestId('drawer-scroll-view');

    expect(scrollView.props.contentContainerStyle).toEqual({ paddingTop: 32 });
  });

  it('applies bottom inset padding to footer actions', () => {
    const props = makeProps();

    const { getByTestId } = render(<DrawerContent {...props} />);
    const bottomSection = getByTestId('drawer-bottom-section');
    expect(bottomSection.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ paddingBottom: 34 })]));
  });

  it('opens server picker from profile section', async () => {
    const props = makeProps();

    const { getByTestId, findByTestId } = render(<DrawerContent {...props} />);
    fireEvent.press(getByTestId('drawer-profile-button'));

    await findByTestId('server-picker-modal');
    await waitFor(() => {
      expect(mockListServers).toHaveBeenCalled();
      expect(mockGetActiveServer).toHaveBeenCalled();
    });
  });

  it('opens guided add-server setup flow from server picker', async () => {
    const props = makeProps();

    const { getByTestId, findByTestId, queryByTestId } = render(<DrawerContent {...props} />);
    fireEvent.press(getByTestId('drawer-profile-button'));
    await findByTestId('server-picker-modal');

    fireEvent.press(getByTestId('server-picker-add-submit'));

    await findByTestId('server-setup-modal');
    expect(queryByTestId('server-picker-modal')).toBeNull();
    expect(getByTestId('server-picker-add-server-setup-step')).toBeTruthy();
    expect(queryByTestId('server-picker-add-input')).toBeNull();
  });

  it('closes setup flow and returns to dashboard when canceled', async () => {
    const props = makeProps();
    const closeDrawer = jest.fn();
    props.navigation.closeDrawer = closeDrawer;

    const { getByTestId, findByTestId, queryByTestId } = render(<DrawerContent {...props} />);
    fireEvent.press(getByTestId('drawer-profile-button'));
    await findByTestId('server-picker-modal');

    fireEvent.press(getByTestId('server-picker-add-submit'));
    await findByTestId('server-setup-modal');

    fireEvent.press(getByTestId('server-picker-add-cancel'));

    await waitFor(() => {
      expect(queryByTestId('server-setup-modal')).toBeNull();
    });
    expect(queryByTestId('server-picker-modal')).toBeNull();
    expect(closeDrawer).toHaveBeenCalled();
  });

  it('renders drawer avatar from profile icon state', () => {
    const props = makeProps();

    const { getByTestId } = render(<DrawerContent {...props} />);
    expect(getByTestId('drawer-user-avatar')).toBeTruthy();
    expect(mockUserAvatar).toHaveBeenCalledWith({
      userId: 'user-1',
      username: 'alice',
      hasProfileIcon: true,
      iconVersion: '2026-01-01T00:00:00Z',
      size: 'large',
    });
  });

  it('passes false hasProfileIcon to drawer avatar when icon is absent', () => {
    mockHasProfileIcon = false;
    const props = makeProps();

    render(<DrawerContent {...props} />);
    expect(mockUserAvatar).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      username: 'alice',
      hasProfileIcon: false,
      size: 'large',
    }));
  });

  it('opens label action menu from explicit menu button', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockLabelsData.push({
      id: 'label-1',
      user_id: 'user-1',
      name: 'Work',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const props = makeProps();

    const { getByTestId } = render(<DrawerContent {...props} />);
    fireEvent.press(getByTestId('drawer-label-menu-label-1'));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const alertCall = alertSpy.mock.calls[0];
    const buttons = (alertCall?.[2] as Array<{ text?: string }> | undefined) ?? [];

    expect(alertCall?.[0]).toBe('Work');
    expect(alertCall?.[1]).toBe('labels.menuOptions');
    expect(buttons.map((button) => button.text)).toEqual(
      expect.arrayContaining(['labels.rename', 'labels.delete', 'common.cancel']),
    );
  });

  it('opens label action menu from long press', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockLabelsData.push({
      id: 'label-1',
      user_id: 'user-1',
      name: 'Work',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const navigate = jest.fn();
    const props = makeProps();
    props.navigation.navigate = navigate;

    const { getByTestId } = render(<DrawerContent {...props} />);
    fireEvent(getByTestId('drawer-label-label-1'), 'onLongPress');

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const alertCall = alertSpy.mock.calls[0];
    const buttons = (alertCall?.[2] as Array<{ text?: string }> | undefined) ?? [];

    expect(alertCall?.[0]).toBe('Work');
    expect(alertCall?.[1]).toBe('labels.menuOptions');
    expect(buttons.map((button) => button.text)).toEqual(
      expect.arrayContaining(['labels.rename', 'labels.delete', 'common.cancel']),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates on first tap after a long press menu is canceled', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockLabelsData.push({
      id: 'label-1',
      user_id: 'user-1',
      name: 'Work',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const navigate = jest.fn();
    const closeDrawer = jest.fn();
    const props = makeProps();
    props.navigation.navigate = navigate;
    props.navigation.closeDrawer = closeDrawer;

    const { getByTestId } = render(<DrawerContent {...props} />);
    fireEvent(getByTestId('drawer-label-label-1'), 'onLongPress');
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const onDismiss = (alertSpy.mock.calls[0]?.[3] as { onDismiss?: () => void } | undefined)?.onDismiss;
    onDismiss?.();

    fireEvent.press(getByTestId('drawer-label-label-1'));

    expect(navigate).toHaveBeenCalledWith('Notes', { labelId: 'label-1', labelName: 'Work' });
    expect(closeDrawer).toHaveBeenCalled();
  });

  it('navigates to label notes when label row is pressed', () => {
    mockLabelsData.push({
      id: 'label-1',
      user_id: 'user-1',
      name: 'Work',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const navigate = jest.fn();
    const closeDrawer = jest.fn();
    const props = makeProps();
    props.navigation.navigate = navigate;
    props.navigation.closeDrawer = closeDrawer;

    const { getByTestId } = render(<DrawerContent {...props} />);
    fireEvent.press(getByTestId('drawer-label-label-1'));

    expect(navigate).toHaveBeenCalledWith('Notes', { labelId: 'label-1', labelName: 'Work' });
    expect(closeDrawer).toHaveBeenCalled();
  });

  it('shows label count badges when counts are available', () => {
    mockLabelsData.push({
      id: 'label-1',
      user_id: 'user-1',
      name: 'Work',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    mockLabelCountsData['label-1'] = 7;

    const props = makeProps();
    const { getByTestId, queryByTestId } = render(<DrawerContent {...props} />);

    expect(getByTestId('drawer-label-count-label-1').props.children).toBe(7);
    expect(queryByTestId('drawer-label-count-missing')).toBeNull();
  });

  it('shows zero label count badge when label count entry is missing', () => {
    mockLabelsData.push({
      id: 'label-1',
      user_id: 'user-1',
      name: 'Work',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });

    const props = makeProps();
    const { getByTestId } = render(<DrawerContent {...props} />);

    expect(getByTestId('drawer-label-count-label-1').props.children).toBe(0);
    expect(getByTestId('drawer-label-label-1').props.accessibilityLabel).toContain('0');
  });

  it('creates a label from the drawer create action', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    const props = makeProps();

    const { getByTestId } = render(<DrawerContent {...props} />);

    fireEvent.press(getByTestId('drawer-label-create'));
    fireEvent.changeText(getByTestId('create-label-input'), 'Errands');
    fireEvent.press(getByTestId('create-label-submit'));

    await waitFor(() => {
      expect(mockCreateLabelMutateAsync).toHaveBeenCalledWith({ name: 'Errands' });
    });
    expect(alertSpy).toHaveBeenCalledWith('labels.createSuccess');
  });

  it('shows a pending spinner on the create-label submit button while the write is in flight (#698)', async () => {
    const { promise, resolve } = deferred<Label>();
    mockCreateLabelMutateAsync.mockReturnValue(promise);
    const props = makeProps();

    const { getByTestId, queryByTestId } = render(<DrawerContent {...props} />);

    fireEvent.press(getByTestId('drawer-label-create'));
    fireEvent.changeText(getByTestId('create-label-input'), 'Errands');
    fireEvent.press(getByTestId('create-label-submit'));

    await waitFor(() => {
      expect(getByTestId('create-label-submit-spinner')).toBeTruthy();
    });

    await act(async () => {
      resolve({
        id: 'label-new',
        user_id: 'user-1',
        name: 'Errands',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      });
    });

    await waitFor(() => {
      expect(queryByTestId('create-label-submit-spinner')).toBeNull();
    });
  });

  it('shows a pending spinner on the rename-label submit button while the write is in flight (#698)', async () => {
    mockLabelsData.push({
      id: 'label-1',
      user_id: 'user-1',
      name: 'Work',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    const { promise, resolve } = deferred<Label>();
    mockRenameLabelMutateAsync.mockReturnValue(promise);
    const props = makeProps();

    const { getByTestId, queryByTestId } = render(<DrawerContent {...props} />);

    fireEvent.press(getByTestId('drawer-label-menu-label-1'));
    const renameButton = (alertSpy.mock.calls[0]?.[2] as Array<{ text?: string; onPress?: () => void }>).find(
      (button) => button.text === 'labels.rename',
    );
    act(() => { renameButton?.onPress?.(); });

    fireEvent.changeText(getByTestId('rename-label-input'), 'Personal');
    fireEvent.press(getByTestId('rename-label-submit'));

    await waitFor(() => {
      expect(getByTestId('rename-label-submit-spinner')).toBeTruthy();
    });

    await act(async () => {
      resolve({
        id: 'label-1',
        user_id: 'user-1',
        name: 'Personal',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      });
    });

    await waitFor(() => {
      expect(queryByTestId('rename-label-submit-spinner')).toBeNull();
    });
  });

  it('shows a pending spinner on the label row while deleting, instead of leaving it with no feedback (#698)', async () => {
    mockLabelsData.push({
      id: 'label-1',
      user_id: 'user-1',
      name: 'Work',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    const { promise, resolve } = deferred<void>();
    mockDeleteLabelMutateAsync.mockReturnValue(promise);
    const props = makeProps();

    const { getByTestId, queryByTestId } = render(
      <ConfirmContext.Provider value={{ confirm: async () => true }}>
        <DrawerContent {...props} />
      </ConfirmContext.Provider>,
    );

    fireEvent.press(getByTestId('drawer-label-menu-label-1'));
    const alertCall = (Alert.alert as jest.Mock).mock.calls[0];
    const deleteButton = (alertCall?.[2] as Array<{ text?: string; onPress?: () => void }>).find(
      (button) => button.text === 'labels.delete',
    );

    await act(async () => {
      deleteButton?.onPress?.();
    });

    await waitFor(() => {
      expect(getByTestId('drawer-label-deleting-label-1')).toBeTruthy();
    });
    expect(queryByTestId('drawer-label-menu-label-1')).toBeNull();
    expect(getByTestId('drawer-label-label-1').props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );

    await act(async () => {
      resolve();
    });

    await waitFor(() => {
      expect(queryByTestId('drawer-label-deleting-label-1')).toBeNull();
    });
    expect(getByTestId('drawer-label-menu-label-1')).toBeTruthy();
  });

  const serverEntries = [
    { serverId: 'srv_a', serverUrl: 'https://a.example.com', lastUsedAt: '2026-01-02T00:00:00Z' },
    { serverId: 'srv_b', serverUrl: 'https://b.example.com', lastUsedAt: '2026-01-01T00:00:00Z' },
  ];

  it('prompts to sign in again and does not close the drawer when the target server session is no longer valid', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockListServers.mockResolvedValue(serverEntries);
    mockGetActiveServer.mockResolvedValue(serverEntries[0]);
    mockSwitchActiveServer.mockResolvedValue(true);
    // revalidateSession returns false when the account on server B was deleted (401).
    mockRevalidateSession.mockResolvedValue(false);

    const closeDrawer = jest.fn();
    const props = makeProps();
    props.navigation.closeDrawer = closeDrawer;

    const { getByTestId, findByTestId, queryByTestId } = render(<DrawerContent {...props} />);
    fireEvent.press(getByTestId('drawer-profile-button'));
    await findByTestId('server-picker-modal');
    await findByTestId('server-picker-row-srv_b');

    fireEvent.press(getByTestId('server-picker-row-srv_b'));

    await waitFor(() => {
      expect(mockSwitchActiveServer).toHaveBeenCalledWith('srv_b');
      expect(mockRevalidateSession).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(queryByTestId('server-picker-modal')).toBeNull();
    });
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        'serverPicker.sessionExpiredTitle',
        'serverPicker.sessionExpiredMessage',
      );
    });
    // The expected re-auth outcome must not be reported as a switch failure, and
    // the auth-state change (isAuthenticated=false) handles navigation, so the
    // drawer must not be closed manually.
    expect(alertSpy).not.toHaveBeenCalledWith('common.error', 'serverPicker.switchFailed');
    expect(closeDrawer).not.toHaveBeenCalled();
  });

  it('switches and closes the drawer when the target server session is valid', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockListServers.mockResolvedValue(serverEntries);
    mockGetActiveServer.mockResolvedValue(serverEntries[0]);
    mockSwitchActiveServer.mockResolvedValue(true);
    mockRevalidateSession.mockResolvedValue(true);

    const closeDrawer = jest.fn();
    const props = makeProps();
    props.navigation.closeDrawer = closeDrawer;

    const { getByTestId, findByTestId } = render(<DrawerContent {...props} />);
    fireEvent.press(getByTestId('drawer-profile-button'));
    await findByTestId('server-picker-modal');
    await findByTestId('server-picker-row-srv_b');

    fireEvent.press(getByTestId('server-picker-row-srv_b'));

    await waitFor(() => {
      expect(mockSwitchActiveServer).toHaveBeenCalledWith('srv_b');
      expect(closeDrawer).toHaveBeenCalled();
    });
    expect(alertSpy).not.toHaveBeenCalledWith('common.error', 'serverPicker.switchFailed');
    expect(alertSpy).not.toHaveBeenCalledWith(
      'serverPicker.sessionExpiredTitle',
      'serverPicker.sessionExpiredMessage',
    );
  });

  it('reports a switch failure when activating the target server fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockListServers.mockResolvedValue(serverEntries);
    mockGetActiveServer.mockResolvedValue(serverEntries[0]);
    mockSwitchActiveServer.mockResolvedValue(false);

    const closeDrawer = jest.fn();
    const props = makeProps();
    props.navigation.closeDrawer = closeDrawer;

    const { getByTestId, findByTestId } = render(<DrawerContent {...props} />);
    fireEvent.press(getByTestId('drawer-profile-button'));
    await findByTestId('server-picker-modal');
    await findByTestId('server-picker-row-srv_b');

    fireEvent.press(getByTestId('server-picker-row-srv_b'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('common.error', 'serverPicker.switchFailed');
    });
    expect(mockRevalidateSession).not.toHaveBeenCalled();
    expect(closeDrawer).not.toHaveBeenCalled();
  });
});
