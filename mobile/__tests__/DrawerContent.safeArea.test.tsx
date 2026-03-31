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
const mockRenameLabelMutateAsync = jest.fn();
const mockDeleteLabelMutateAsync = jest.fn();

jest.mock('../src/store/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      username: 'alice',
      first_name: 'Alice',
      last_name: 'Smith',
      role: 'user',
      has_profile_icon: false,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    logout: jest.fn(),
    revalidateSession: jest.fn(async () => true),
  }),
}));

jest.mock('../src/hooks/useLabels', () => ({
  useLabels: () => ({ data: mockLabelsData }),
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
  useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
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

describe('DrawerContent safe-area spacing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLabelsData.length = 0;
    mockListServers.mockResolvedValue([]);
    mockGetActiveServer.mockResolvedValue(null);
    mockAddServer.mockResolvedValue({ success: true, serverId: 'srv_new' });
    mockSwitchActiveServer.mockResolvedValue(true);
  });

  it('applies top inset padding to drawer scroll content', () => {
    const props = {
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
    } as unknown as DrawerContentComponentProps;

    const { getByTestId } = render(<DrawerContent {...props} />);
    const scrollView = getByTestId('drawer-scroll-view');

    expect(scrollView.props.contentContainerStyle).toEqual({ paddingTop: 32 });
  });

  it('opens server picker from profile section', async () => {
    const props = {
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
    } as unknown as DrawerContentComponentProps;

    const { getByTestId, findByTestId } = render(<DrawerContent {...props} />);
    fireEvent.press(getByTestId('drawer-profile-button'));

    await findByTestId('server-picker-modal');
    await waitFor(() => {
      expect(mockListServers).toHaveBeenCalled();
      expect(mockGetActiveServer).toHaveBeenCalled();
    });
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

    const props = {
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
    } as unknown as DrawerContentComponentProps;

    const { getByTestId } = render(<DrawerContent {...props} />);
    fireEvent.press(getByTestId('drawer-label-menu-label-1'));

    const alertCall = alertSpy.mock.calls[alertSpy.mock.calls.length - 1];
    const buttons = (alertCall?.[2] as Array<{ text?: string }> | undefined) ?? [];

    expect(alertCall?.[0]).toBe('Work');
    expect(alertCall?.[1]).toBe('labels.menuOptions');
    expect(buttons.map((button) => button.text)).toEqual(
      expect.arrayContaining(['labels.rename', 'labels.delete', 'common.cancel']),
    );

    alertSpy.mockRestore();
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
    const props = {
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
        navigate,
        closeDrawer,
        dispatch: jest.fn(),
      },
      descriptors: {},
      progress: {},
    } as unknown as DrawerContentComponentProps;

    const { getByTestId } = render(<DrawerContent {...props} />);
    fireEvent.press(getByTestId('drawer-label-label-1'));

    expect(navigate).toHaveBeenCalledWith('Notes', { labelId: 'label-1', labelName: 'Work' });
    expect(closeDrawer).toHaveBeenCalled();
  });
});
