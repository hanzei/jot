/**
 * Tests for queued settings changes (issues #485, #1285). Language, theme and
 * profile changes go through the outbox whatever the connectivity: they apply
 * optimistically to the session and its cache and queue an `updateSettings`
 * row, and never call the server themselves. Only a failure of the local
 * enqueue reverts them; a server rejection arrives later, from the drain.
 */

import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import SettingsScreen from '../src/screens/SettingsScreen';
import { useAuth } from '../src/store/AuthContext';
import { cacheAuthProfile } from '../src/api/client';
import { enqueueSettingsUpdate } from '../src/db/syncQueue';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';
import i18n from '../src/i18n';
import type { User } from '@jot/shared';
import { jot } from '../src/api/jot';

// ── mocks ──────────────────────────────────────────────────────────────────

jest.mock('../src/api/jot', () => ({
  jot: {
    notes: {
      getAll: jest.fn(),
    },
    users: {
      updateMe: jest.fn(),
      changePassword: jest.fn(),
      deleteProfileIcon: jest.fn(),
    },
    about: {
      get: jest.fn(),
    },
    sessions: {
      list: jest.fn(),
      revoke: jest.fn(),
    },
    pats: {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      revoke: jest.fn(),
    },
  },
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/api/settings', () => ({
  uploadProfileIcon: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  getBaseUrl: jest.fn(() => 'http://localhost:8080'),
  subscribeToClientActiveServerChanges: jest.fn(() => () => {}),
  cacheAuthProfile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/db/syncQueue', () => ({
  ...jest.requireActual('../src/db/syncQueue'),
  enqueueSettingsUpdate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/store/serverAccounts', () => ({
  getActiveServer: jest.fn(async () => ({ serverUrl: 'https://active.example.com' })),
}));

jest.mock('../src/hooks/useServerConfig', () => ({
  useServerConfig: jest.fn(() => ({ registration_enabled: true, password_min_length: 10, upload_max_bytes: 26214400 })),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { createContext } = jest.requireActual<typeof import('react')>('react');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    __esModule: true,
    useSafeAreaInsets: () => insets,
    SafeAreaInsetsContext: createContext(insets),
  };
});

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
  importFile: jest.fn(),
}));

// ── fixtures ───────────────────────────────────────────────────────────────

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUpdateMe = jest.mocked(jot.users.updateMe);
const mockListSessions = jest.mocked(jot.sessions.list);
const mockCacheAuthProfile = cacheAuthProfile as jest.MockedFunction<typeof cacheAuthProfile>;
const mockEnqueueSettingsUpdate = jest.mocked(enqueueSettingsUpdate);

const baseUser: User = {
  id: 'user-1',
  username: 'alice',
  first_name: 'Alice',
  last_name: 'Smith',
  role: 'user',
  has_profile_icon: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

const baseSettings = {
  user_id: 'user-1',
  language: 'en',
  theme: 'system' as const,
  note_sort: 'manual' as const,
  updated_at: '2026-01-02T00:00:00Z',
};

function setupAuth(overrides?: { settings?: typeof baseSettings; user?: User }) {
  const setUser = jest.fn();
  const setSettings = jest.fn();
  mockUseAuth.mockImplementation(
    () =>
      ({
        isAuthenticated: true,
        isLoading: false,
        user: overrides?.user ?? baseUser,
        settings: overrides?.settings ?? baseSettings,
        setUser,
        setSettings,
        login: jest.fn(),
        register: jest.fn(),
        logout: jest.fn(),
        revalidateSession: jest.fn(),
      }) as unknown as ReturnType<typeof useAuth>,
  );
  return { setUser, setSettings };
}

// ── test suite ─────────────────────────────────────────────────────────────

describe('SettingsScreen queued settings changes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    markServerReachable();
    mockListSessions.mockResolvedValue([]);
  });

  afterEach(async () => {
    // The screen is still mounted here (RNTL unmounts after this hook), and
    // ExportSection re-renders on a reachability flip.
    await act(async () => {
      markServerReachable();
    });
  });

  async function renderSettings() {
    const view = await render(<SettingsScreen />);
    await waitFor(() => expect(mockListSessions).toHaveBeenCalled());
    return view;
  }

  // Online or not, the change is queued and the server is not called.
  describe.each([
    ['reachable', () => markServerReachable()],
    ['known-unreachable', () => markServerUnreachable()],
  ])('while the server is %s', (_state, setReachability) => {
    it('applies a language change, caches it and queues it', async () => {
      const { setSettings } = setupAuth();
      setReachability();
      const { getByTestId } = await renderSettings();

      await fireEvent.press(getByTestId('settings-language-dropdown'));
      await fireEvent.press(getByTestId('settings-language-de'));

      await waitFor(() => expect(mockEnqueueSettingsUpdate).toHaveBeenCalledWith(expect.anything(), { language: 'de' }));
      expect(mockUpdateMe).not.toHaveBeenCalled();
      expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'de' }));
      expect(mockCacheAuthProfile).toHaveBeenCalledWith(
        expect.objectContaining({ settings: expect.objectContaining({ language: 'de' }) }),
      );
    });

    it('applies a theme change, caches it and queues it', async () => {
      const { setSettings } = setupAuth();
      setReachability();
      const { getByTestId } = await renderSettings();

      await fireEvent.press(getByTestId('settings-theme-dropdown'));
      await fireEvent.press(getByTestId('settings-theme-dark'));

      await waitFor(() => expect(mockEnqueueSettingsUpdate).toHaveBeenCalledWith(expect.anything(), { theme: 'dark' }));
      expect(mockUpdateMe).not.toHaveBeenCalled();
      expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));
    });

    it('applies a profile save to the session, caches it and queues it', async () => {
      const { setUser, setSettings } = setupAuth();
      setReachability();
      const { getByTestId, getByText } = await renderSettings();

      await fireEvent.changeText(getByTestId('settings-first-name'), 'Alicia');
      await fireEvent.press(getByTestId('settings-save-profile'));

      await waitFor(() => expect(mockEnqueueSettingsUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { username: 'alice', first_name: 'Alicia', last_name: 'Smith' },
      ));
      expect(mockUpdateMe).not.toHaveBeenCalled();
      expect(setUser).toHaveBeenCalledWith(expect.objectContaining({ first_name: 'Alicia' }));
      expect(setSettings).not.toHaveBeenCalled();
      expect(mockCacheAuthProfile).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.objectContaining({ first_name: 'Alicia' }) }),
      );
      expect(getByText(i18n.t('settings.profileUpdated'))).toBeTruthy();
    });
  });

  it('reverts the language and shows an error when the local enqueue fails', async () => {
    const { setSettings } = setupAuth();
    mockEnqueueSettingsUpdate.mockRejectedValueOnce(new Error('sqlite write failed'));
    const { getByTestId, getByText } = await renderSettings();

    await fireEvent.press(getByTestId('settings-language-dropdown'));
    await fireEvent.press(getByTestId('settings-language-de'));

    // Nothing was queued, so the optimistic change is rolled back rather than
    // left dangling forever.
    await waitFor(() => {
      expect(getByText(i18n.t('settings.failedUpdateLanguage'))).toBeTruthy();
    });
    expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'en' }));
  });

  it('reverts the theme and shows an error when the local enqueue fails', async () => {
    const { setSettings } = setupAuth();
    mockEnqueueSettingsUpdate.mockRejectedValueOnce(new Error('sqlite write failed'));
    const { getByTestId, getByText } = await renderSettings();

    await fireEvent.press(getByTestId('settings-theme-dropdown'));
    await fireEvent.press(getByTestId('settings-theme-dark'));

    await waitFor(() => {
      expect(getByText(i18n.t('settings.failedUpdateTheme'))).toBeTruthy();
    });
    expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'system' }));
  });

  it('reverts the profile and shows an error when the local enqueue fails', async () => {
    const { setUser } = setupAuth();
    mockEnqueueSettingsUpdate.mockRejectedValueOnce(new Error('sqlite write failed'));
    const { getByTestId, getByText } = await renderSettings();

    await fireEvent.press(getByTestId('settings-save-profile'));

    await waitFor(() => {
      expect(getByText(i18n.t('settings.failedUpdateProfile'))).toBeTruthy();
    });
    expect(setUser).toHaveBeenLastCalledWith(baseUser);
  });

  it('rejects an invalid username before queueing it, since the server would only reject it later', async () => {
    const { setUser } = setupAuth();
    const { getByTestId, getByText } = await renderSettings();

    await fireEvent.changeText(getByTestId('settings-username'), 'Alice');
    await fireEvent.press(getByTestId('settings-save-profile'));

    expect(getByText(i18n.t('auth.usernameChars'))).toBeTruthy();
    expect(mockEnqueueSettingsUpdate).not.toHaveBeenCalled();
    expect(setUser).not.toHaveBeenCalled();
  });
});
