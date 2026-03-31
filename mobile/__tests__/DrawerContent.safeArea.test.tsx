import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { DrawerContentComponentProps } from '@react-navigation/drawer';
import DrawerContent from '../src/components/DrawerContent';

const mockSwitchActiveServer = jest.fn();
const mockListServers = jest.fn();
const mockGetActiveServer = jest.fn();
const mockAddServer = jest.fn();
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
  useLabels: () => ({ data: [] }),
  useRenameLabel: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeleteLabel: () => ({ mutateAsync: jest.fn(), isPending: false }),
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

describe('DrawerContent safe-area spacing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasProfileIcon = true;
    mockListServers.mockResolvedValue([]);
    mockGetActiveServer.mockResolvedValue(null);
    mockAddServer.mockResolvedValue({ success: true, serverId: 'srv_new' });
    mockSwitchActiveServer.mockResolvedValue(true);
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
});
