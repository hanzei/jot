/**
 * Tests for offline / queued settings changes (issue #485).
 * Verifies that language, theme, and profile changes:
 *  - persist optimistically to local cache when the API call fails transiently,
 *  - enqueue the operation for later replay, and
 *  - revert + show an error when the failure is permanent.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import SettingsScreen from '../src/screens/SettingsScreen';
import { useAuth } from '../src/store/AuthContext';
import { updateMe, listSessions } from '../src/api/settings';
import { cacheAuthProfile } from '../src/api/client';
import { enqueueOperation } from '../src/db/syncQueue';
import type { User } from '@jot/shared';

// ── helpers ────────────────────────────────────────────────────────────────

function makeAxiosError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true,
    response: { status },
  });
}

function makeNetworkError() {
  return Object.assign(new Error('Network Error'), { isAxiosError: true });
}

// ── mocks ──────────────────────────────────────────────────────────────────

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
  listPATs: jest.fn().mockResolvedValue([]),
  createPAT: jest.fn(),
  revokePAT: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  getBaseUrl: jest.fn(() => 'http://localhost:8080'),
  subscribeToClientActiveServerChanges: jest.fn(() => () => {}),
  cacheAuthProfile: jest.fn().mockResolvedValue(undefined),
  getSessionCookieHeader: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/db/syncQueue', () => ({
  ...jest.requireActual('../src/db/syncQueue'),
  enqueueOperation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/store/serverAccounts', () => ({
  getActiveServer: jest.fn(async () => ({ serverUrl: 'https://active.example.com' })),
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
  importKeepFile: jest.fn(),
  getNotes: jest.fn(),
}));

// ── fixtures ───────────────────────────────────────────────────────────────

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUpdateMe = updateMe as jest.MockedFunction<typeof updateMe>;
const mockListSessions = listSessions as jest.MockedFunction<typeof listSessions>;
const mockCacheAuthProfile = cacheAuthProfile as jest.MockedFunction<typeof cacheAuthProfile>;
const mockEnqueueOperation = enqueueOperation as jest.MockedFunction<typeof enqueueOperation>;

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

describe('SettingsScreen offline / queued settings changes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListSessions.mockResolvedValue([]);
  });

  // ── language ────────────────────────────────────────────────────────────

  describe('language change', () => {
    it('persists to cache and enqueues when updateMe fails transiently (network error)', async () => {
      const { setSettings } = setupAuth();
      mockUpdateMe.mockRejectedValue(makeNetworkError());

      const { getByTestId } = render(<SettingsScreen />);
      await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

      fireEvent.press(getByTestId('settings-language-dropdown'));
      fireEvent.press(getByTestId('settings-language-de'));

      await waitFor(() => expect(mockEnqueueOperation).toHaveBeenCalled());

      // Settings should be updated optimistically (not reverted)
      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'de' }),
      );
      // Cache should be updated with the new language
      expect(mockCacheAuthProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ language: 'de' }),
        }),
      );
      // Operation should be enqueued for replay
      expect(mockEnqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'updateSettings',
          endpoint: '/users/me',
          method: 'PATCH',
          body: { language: 'de' },
        }),
      );
    });

    it('persists to cache and enqueues when updateMe fails transiently (5xx)', async () => {
      const { setSettings } = setupAuth();
      mockUpdateMe.mockRejectedValue(makeAxiosError(503));

      const { getByTestId } = render(<SettingsScreen />);
      await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

      fireEvent.press(getByTestId('settings-language-dropdown'));
      fireEvent.press(getByTestId('settings-language-fr'));

      await waitFor(() => expect(mockEnqueueOperation).toHaveBeenCalled());

      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'fr' }),
      );
      expect(mockEnqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: { language: 'fr' } }),
      );
    });

    it('reverts language and shows error when updateMe fails permanently (4xx)', async () => {
      const { setSettings } = setupAuth();
      mockUpdateMe.mockRejectedValue(
        Object.assign(makeAxiosError(422), { response: { status: 422, data: 'invalid language' } }),
      );

      const { getByTestId, getByText } = render(<SettingsScreen />);
      await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

      fireEvent.press(getByTestId('settings-language-dropdown'));
      fireEvent.press(getByTestId('settings-language-de'));

      await waitFor(() => {
        expect(getByText('invalid language')).toBeTruthy();
      });

      // The last setSettings call should revert to the original settings
      const allCalls = setSettings.mock.calls;
      const lastCall = allCalls[allCalls.length - 1][0];
      expect(lastCall).toEqual(expect.objectContaining({ language: 'en' }));

      // Should NOT enqueue
      expect(mockEnqueueOperation).not.toHaveBeenCalled();
    });

    it('reverts language and shows error when updateMe fails with 400', async () => {
      setupAuth();
      mockUpdateMe.mockRejectedValue(
        Object.assign(makeAxiosError(400), { response: { status: 400, data: 'bad request' } }),
      );

      const { getByTestId, getByText } = render(<SettingsScreen />);
      await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

      fireEvent.press(getByTestId('settings-language-dropdown'));
      fireEvent.press(getByTestId('settings-language-de'));

      await waitFor(() => {
        expect(getByText('bad request')).toBeTruthy();
      });

      expect(mockEnqueueOperation).not.toHaveBeenCalled();
    });
  });

  // ── theme ────────────────────────────────────────────────────────────────

  describe('theme change', () => {
    it('persists to cache and enqueues when updateMe fails transiently (network error)', async () => {
      const { setSettings } = setupAuth();
      mockUpdateMe.mockRejectedValue(makeNetworkError());

      const { getByTestId } = render(<SettingsScreen />);
      await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

      fireEvent.press(getByTestId('settings-theme-dropdown'));
      fireEvent.press(getByTestId('settings-theme-dark'));

      await waitFor(() => expect(mockEnqueueOperation).toHaveBeenCalled());

      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'dark' }),
      );
      expect(mockCacheAuthProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ theme: 'dark' }),
        }),
      );
      expect(mockEnqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'updateSettings',
          endpoint: '/users/me',
          method: 'PATCH',
          body: { theme: 'dark' },
        }),
      );
    });

    it('persists to cache and enqueues when updateMe fails transiently (5xx)', async () => {
      const { setSettings } = setupAuth();
      mockUpdateMe.mockRejectedValue(makeAxiosError(500));

      const { getByTestId } = render(<SettingsScreen />);
      await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

      fireEvent.press(getByTestId('settings-theme-dropdown'));
      fireEvent.press(getByTestId('settings-theme-light'));

      await waitFor(() => expect(mockEnqueueOperation).toHaveBeenCalled());

      expect(setSettings).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'light' }),
      );
      expect(mockEnqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: { theme: 'light' } }),
      );
    });

    it('reverts theme and shows error when updateMe fails permanently (4xx)', async () => {
      const { setSettings } = setupAuth();
      mockUpdateMe.mockRejectedValue(
        Object.assign(makeAxiosError(422), { response: { status: 422, data: 'invalid theme' } }),
      );

      const { getByTestId, getByText } = render(<SettingsScreen />);
      await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

      fireEvent.press(getByTestId('settings-theme-dropdown'));
      fireEvent.press(getByTestId('settings-theme-dark'));

      await waitFor(() => {
        expect(getByText('invalid theme')).toBeTruthy();
      });

      const allCalls = setSettings.mock.calls;
      const lastCall = allCalls[allCalls.length - 1][0];
      expect(lastCall).toEqual(expect.objectContaining({ theme: 'system' }));

      expect(mockEnqueueOperation).not.toHaveBeenCalled();
    });

    it('reverts theme and shows error when updateMe fails with 403', async () => {
      setupAuth();
      mockUpdateMe.mockRejectedValue(
        Object.assign(makeAxiosError(403), { response: { status: 403, data: 'forbidden' } }),
      );

      const { getByTestId, getByText } = render(<SettingsScreen />);
      await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

      fireEvent.press(getByTestId('settings-theme-dropdown'));
      fireEvent.press(getByTestId('settings-theme-dark'));

      await waitFor(() => {
        expect(getByText('forbidden')).toBeTruthy();
      });

      expect(mockEnqueueOperation).not.toHaveBeenCalled();
    });
  });

  // ── profile save ─────────────────────────────────────────────────────────

  describe('profile save', () => {
    it('applies optimistic user update, caches, and enqueues when updateMe fails transiently', async () => {
      const { setUser, setSettings } = setupAuth();
      mockUpdateMe.mockRejectedValue(makeNetworkError());

      const { getByTestId } = render(<SettingsScreen />);
      await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

      fireEvent.press(getByTestId('settings-save-profile'));

      await waitFor(() => expect(mockEnqueueOperation).toHaveBeenCalled());

      // User should be updated optimistically
      expect(setUser).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'alice',
          first_name: 'Alice',
          last_name: 'Smith',
        }),
      );
      // Settings should not change for profile update (only user changes)
      expect(setSettings).not.toHaveBeenCalled();
      // Cache should be updated
      expect(mockCacheAuthProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({ username: 'alice' }),
        }),
      );
      // Operation should be enqueued
      expect(mockEnqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'updateSettings',
          endpoint: '/users/me',
          method: 'PATCH',
          body: expect.objectContaining({ username: 'alice' }),
        }),
      );
    });

    it('applies optimistic user update and enqueues when updateMe fails with 5xx', async () => {
      const { setUser } = setupAuth();
      mockUpdateMe.mockRejectedValue(makeAxiosError(503));

      const { getByTestId } = render(<SettingsScreen />);
      await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

      fireEvent.press(getByTestId('settings-save-profile'));

      await waitFor(() => expect(mockEnqueueOperation).toHaveBeenCalled());

      expect(setUser).toHaveBeenCalled();
      expect(mockEnqueueOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          operation: 'updateSettings',
          body: expect.objectContaining({ username: 'alice' }),
        }),
      );
    });

    it('applies optimistic update then reverts and shows error when updateMe fails permanently (4xx)', async () => {
      const { setUser } = setupAuth();
      mockUpdateMe.mockRejectedValue(
        Object.assign(makeAxiosError(422), { response: { status: 422, data: 'username taken' } }),
      );

      const { getByTestId, getByText } = render(<SettingsScreen />);
      await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

      fireEvent.press(getByTestId('settings-save-profile'));

      await waitFor(() => {
        expect(getByText('username taken')).toBeTruthy();
      });

      // First call: optimistic update; second call: revert to original
      expect(setUser).toHaveBeenCalledTimes(2);
      expect(setUser).toHaveBeenNthCalledWith(1, expect.objectContaining({ username: 'alice' }));
      expect(setUser).toHaveBeenNthCalledWith(2, baseUser);
      expect(mockEnqueueOperation).not.toHaveBeenCalled();
    });

    it('applies optimistic update then reverts and shows error when updateMe fails with 400', async () => {
      const { setUser } = setupAuth();
      mockUpdateMe.mockRejectedValue(
        Object.assign(makeAxiosError(400), { response: { status: 400, data: 'invalid input' } }),
      );

      const { getByTestId, getByText } = render(<SettingsScreen />);
      await waitFor(() => expect(mockListSessions).toHaveBeenCalled());

      fireEvent.press(getByTestId('settings-save-profile'));

      await waitFor(() => {
        expect(getByText('invalid input')).toBeTruthy();
      });

      expect(setUser).toHaveBeenCalledTimes(2);
      expect(setUser).toHaveBeenNthCalledWith(2, baseUser);
      expect(mockEnqueueOperation).not.toHaveBeenCalled();
    });
  });
});
