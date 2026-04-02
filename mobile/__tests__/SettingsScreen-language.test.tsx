import React from 'react';
import { Alert, Text } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { useTranslation } from 'react-i18next';
import SettingsScreen from '../src/screens/SettingsScreen';
import MobileI18nProvider from '../src/i18n/MobileI18nProvider';
import i18n from '../src/i18n';
import { useAuth } from '../src/store/AuthContext';
import { updateMe, listSessions, getAboutInfo, revokeSession } from '../src/api/settings';
import type { User } from '@jot/shared';

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/api/settings', () => ({
  updateMe: jest.fn(),
  changePassword: jest.fn(),
  uploadProfileIcon: jest.fn(),
  deleteProfileIcon: jest.fn(),
  getAboutInfo: jest.fn(),
  listSessions: jest.fn(),
  revokeSession: jest.fn(),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: jest.fn(),
  }),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

jest.mock('../src/api/notes', () => ({
  importKeepFile: jest.fn(),
  getNotes: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  getBaseUrl: jest.fn(() => 'http://localhost:8080'),
  subscribeToClientActiveServerChanges: jest.fn(() => () => {}),
}));

jest.mock('../src/store/serverAccounts', () => ({
  getActiveServer: jest.fn(async () => ({ serverUrl: 'https://active.example.com' })),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUpdateMe = updateMe as jest.MockedFunction<typeof updateMe>;
const mockListSessions = listSessions as jest.MockedFunction<typeof listSessions>;
const mockGetAboutInfo = getAboutInfo as jest.MockedFunction<typeof getAboutInfo>;
const mockRevokeSession = revokeSession as jest.MockedFunction<typeof revokeSession>;

const user: User = {
  id: 'user-1',
  username: 'alice',
  first_name: 'Alice',
  last_name: 'Smith',
  role: 'user',
  has_profile_icon: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

let currentSettings = {
  user_id: 'user-1',
  language: 'system',
  theme: 'system' as const,
  note_sort: 'manual' as const,
  updated_at: '2026-01-02T00:00:00Z',
};

const setSettings = jest.fn((next) => {
  currentSettings = next;
});

const setUser = jest.fn();
const authStateBase = {
  isAuthenticated: true,
  isLoading: false,
  login: jest.fn(),
  register: jest.fn(),
  logout: jest.fn(),
  revalidateSession: jest.fn(),
};

function TranslationProbe() {
  const { t } = useTranslation();
  return <Text testID="settings-title">{t('settings.title')}</Text>;
}

describe('SettingsScreen language selection', () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());

  afterAll(() => {
    alertSpy.mockRestore();
  });

  beforeEach(async () => {
    currentSettings = {
      user_id: 'user-1',
      language: 'system',
      theme: 'system',
      note_sort: 'manual',
      updated_at: '2026-01-02T00:00:00Z',
    };
    setSettings.mockClear();
    setUser.mockClear();
    mockRevokeSession.mockClear();
    mockListSessions.mockResolvedValue([
      {
        id: 'current-session',
        browser: 'Mobile Safari',
        os: 'iOS',
        is_current: true,
        created_at: '2026-01-02T00:00:00Z',
        expires_at: '2026-02-02T00:00:00Z',
      },
      {
        id: 'other-session',
        browser: 'Chrome',
        os: 'Android',
        is_current: false,
        created_at: '2026-01-01T00:00:00Z',
        expires_at: '2026-02-01T00:00:00Z',
      },
    ]);
    mockGetAboutInfo.mockResolvedValue({
      version: 'dev',
      commit: 'deadbeef',
      build_time: '2026-01-02T00:00:00Z',
      go_version: 'go1.25.0',
    });
    mockRevokeSession.mockResolvedValue(undefined);
    alertSpy.mockClear();
    mockUseAuth.mockImplementation(
      () =>
        ({
          ...authStateBase,
          user,
          settings: currentSettings,
          setUser,
          setSettings,
        }) as unknown as ReturnType<typeof useAuth>,
    );
    await i18n.changeLanguage('en');
  });

  it('persists the selected language and restores it after remounting auth-backed i18n', async () => {
    const updatedSettings = {
      ...currentSettings,
      language: 'de',
    };
    mockUpdateMe.mockResolvedValue({
      user,
      settings: updatedSettings,
    });

    const { getByTestId } = render(<SettingsScreen />);

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalled();
    });

    fireEvent.press(getByTestId('settings-language-dropdown'));
    fireEvent.press(getByTestId('settings-language-de'));

    await waitFor(() => {
      expect(mockUpdateMe).toHaveBeenCalledWith({ language: 'de' });
    });

    await waitFor(() => {
      expect(i18n.language).toBe('de');
    });

    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ language: 'de' }));

    mockUseAuth.mockImplementation(
      () =>
        ({
          ...authStateBase,
          user,
          settings: updatedSettings,
          setUser,
          setSettings,
        }) as unknown as ReturnType<typeof useAuth>,
    );

    const { getByTestId: getProbeByTestId } = render(
      <MobileI18nProvider>
        <TranslationProbe />
      </MobileI18nProvider>,
    );

    await waitFor(() => {
      expect(getProbeByTestId('settings-title').props.children).toBe('Einstellungen');
    });
  });

  it('persists selected theme through the theme dropdown', async () => {
    const updatedSettings = {
      ...currentSettings,
      theme: 'dark' as const,
    };
    mockUpdateMe.mockResolvedValue({
      user,
      settings: updatedSettings,
    });

    const { getByTestId } = render(<SettingsScreen />);

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalled();
    });

    fireEvent.press(getByTestId('settings-theme-dropdown'));
    fireEvent.press(getByTestId('settings-theme-dark'));

    await waitFor(() => {
      expect(mockUpdateMe).toHaveBeenCalledWith({ theme: 'dark' });
    });

    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
  });

  it('shows active server identity in the about section only', async () => {
    const { getByTestId, getByText, queryByText } = render(<SettingsScreen />);

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalled();
    });

    expect(queryByText(i18n.t('about.serverOrigin'))).toBeNull();
    expect(queryByText('https://active.example.com')).toBeNull();
    fireEvent.press(getByTestId('settings-about-toggle'));
    await waitFor(() => {
      expect(getByText(i18n.t('about.serverOrigin'))).toBeTruthy();
      expect(getByText('https://active.example.com')).toBeTruthy();
      expect(getByText('deadbeef')).toBeTruthy();
    });
  });

  it('asks for confirmation before revoking a session', async () => {
    const { getByTestId } = render(<SettingsScreen />);

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalled();
    });

    fireEvent.press(getByTestId('settings-revoke-session-other-session'));

    expect(alertSpy).toHaveBeenCalledWith(
      'Revoke session',
      'Are you sure you want to revoke this session?',
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Cancel',
          style: 'cancel',
        }),
        expect.objectContaining({
          text: 'Revoke',
          style: 'destructive',
          onPress: expect.any(Function),
        }),
      ]),
    );
    expect(mockRevokeSession).not.toHaveBeenCalled();

    const [, , actions] = alertSpy.mock.calls[0] as [string, string, Array<{ text: string; onPress?: () => void }>];
    const revokeAction = actions.find(action => action.text === 'Revoke');
    expect(revokeAction).toBeDefined();
    await act(async () => {
      revokeAction?.onPress?.();
    });

    await waitFor(() => {
      expect(mockRevokeSession).toHaveBeenCalledWith('other-session');
    });
  });

  it('does not revoke when the confirmation is cancelled', async () => {
    const { getByTestId } = render(<SettingsScreen />);

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalled();
    });

    fireEvent.press(getByTestId('settings-revoke-session-other-session'));

    const [, , actions] = alertSpy.mock.calls[0] as [string, string, Array<{ text: string; onPress?: () => void }>];
    const cancelAction = actions.find(action => action.text === 'Cancel');
    expect(cancelAction).toBeDefined();
    cancelAction?.onPress?.();

    await waitFor(() => {
      expect(mockRevokeSession).not.toHaveBeenCalled();
    });
  });
});
