import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { useTranslation } from 'react-i18next';
import SettingsScreen from '../src/screens/SettingsScreen';
import MobileI18nProvider from '../src/i18n/MobileI18nProvider';
import i18n from '../src/i18n';
import { useAuth } from '../src/store/AuthContext';
import { updateMe, listSessions } from '../src/api/settings';

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

const user = {
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
    mockListSessions.mockResolvedValue([]);
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

    expect(queryByText(i18n.t('settings.currentServerLabel'))).toBeNull();
    fireEvent.press(getByTestId('settings-about-toggle'));
    expect(getByText(i18n.t('about.serverOrigin'))).toBeTruthy();
    expect(getByText('https://active.example.com')).toBeTruthy();
  });
});
