import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { DrawerContentComponentProps } from '@react-navigation/drawer';
import DrawerContent from '../src/components/DrawerContent';
import type { Label } from '@jot/shared';

const mockSwitchActiveServer = jest.fn();
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
    revalidateSession: jest.fn(async () => true),
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

jest.mock('../src/hooks/useLabels', () => ({
  useLabels: () => ({ data: mockLabelsData }),
  useLabelCounts: () => ({ data: mockLabelCountsData }),
  useCreateLabel: () => ({ mutateAsync: mockCreateLabelMutateAsync, isPending: false }),
  useRenameLabel: () => ({ mutateAsync: mockRenameLabelMutateAsync, isPending: false }),
  useDeleteLabel: () => ({ mutateAsync: mockDeleteLabelMutateAsync, isPending: false }),
}));

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
    routeNames: ['Notes', 'MyTodo', 'Archived', 'Trash'],
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
});
