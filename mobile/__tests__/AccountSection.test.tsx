import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import AccountSection from '../src/screens/settings/AccountSection';
import { useAuth } from '../src/store/AuthContext';
import { updateMe } from '../src/api/settings';
import { cacheAuthProfile } from '../src/api/client';
import { enqueueOperation } from '../src/db/syncQueue';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';
import i18n from '../src/i18n';

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/api/settings', () => ({
  updateMe: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  cacheAuthProfile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/db/syncQueue', () => ({
  enqueueOperation: jest.fn().mockResolvedValue(undefined),
  isQueueableError: jest.fn(() => false),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUpdateMe = updateMe as jest.MockedFunction<typeof updateMe>;
const mockCacheAuthProfile = cacheAuthProfile as jest.MockedFunction<typeof cacheAuthProfile>;
const mockEnqueueOperation = enqueueOperation as jest.MockedFunction<typeof enqueueOperation>;

const user = {
  id: 'local-id',
  username: 'local',
  first_name: 'Alice',
  last_name: '',
  role: 'user' as const,
  has_profile_icon: false,
  created_at: '',
  updated_at: '',
};
const settings = {
  user_id: 'local-id',
  language: 'en',
  theme: 'system' as const,
  note_sort: 'manual' as const,
  updated_at: '',
};

const setUser = jest.fn();
const setSettings = jest.fn();

function mockAuth(isLocalMode: boolean) {
  mockUseAuth.mockImplementation(
    () =>
      ({
        user,
        settings,
        setUser,
        setSettings,
        isLocalMode,
      }) as unknown as ReturnType<typeof useAuth>,
  );
}

describe('AccountSection', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    markServerReachable();
    await i18n.changeLanguage('en');
  });

  afterEach(() => {
    markServerReachable();
  });

  it('saves the profile to the server in server mode', async () => {
    mockAuth(false);
    mockUpdateMe.mockResolvedValue({ user, settings });

    const { getByTestId } = render(<AccountSection />);
    fireEvent.changeText(getByTestId('settings-first-name'), 'Renamed');
    fireEvent.press(getByTestId('settings-save-profile'));

    await waitFor(() => {
      expect(mockUpdateMe).toHaveBeenCalledWith(
        expect.objectContaining({ first_name: 'Renamed' }),
      );
    });
    // Server-backed updates are mirrored into the offline auth cache.
    expect(mockCacheAuthProfile).toHaveBeenCalled();
  });

  it('does not touch the server or sync queue in local mode', async () => {
    mockAuth(true);

    const { getByTestId, getByText } = render(<AccountSection />);
    fireEvent.changeText(getByTestId('settings-first-name'), 'Renamed');
    fireEvent.press(getByTestId('settings-save-profile'));

    // Optimistic update is applied and surfaced as a success...
    await waitFor(() => {
      expect(getByText(i18n.t('settings.profileUpdated'))).toBeTruthy();
    });
    expect(setUser).toHaveBeenCalledWith(
      expect.objectContaining({ first_name: 'Renamed' }),
    );
    // ...but no server call, nothing enqueued onto the never-draining queue, and
    // no write to the server-keyed offline auth cache.
    expect(mockUpdateMe).not.toHaveBeenCalled();
    expect(mockEnqueueOperation).not.toHaveBeenCalled();
    expect(mockCacheAuthProfile).not.toHaveBeenCalled();
  });

  it('skips the network round-trip and enqueues when the server is known-unreachable', async () => {
    mockAuth(false);
    markServerUnreachable();

    const { getByTestId, getByText } = render(<AccountSection />);
    fireEvent.changeText(getByTestId('settings-first-name'), 'Renamed');
    fireEvent.press(getByTestId('settings-save-profile'));

    await waitFor(() => {
      expect(getByText(i18n.t('settings.profileUpdated'))).toBeTruthy();
    });

    // The doomed round-trip is skipped entirely; the change goes straight to the queue.
    expect(mockUpdateMe).not.toHaveBeenCalled();
    expect(mockEnqueueOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'updateSettings',
        endpoint: '/users/me',
        method: 'PATCH',
        body: expect.objectContaining({ first_name: 'Renamed' }),
      }),
    );
  });

  it('rolls back and re-enables the save button when the local enqueue itself fails', async () => {
    mockAuth(false);
    markServerUnreachable();
    mockEnqueueOperation.mockRejectedValueOnce(new Error('sqlite write failed'));

    const { getByTestId, getByText } = render(<AccountSection />);
    fireEvent.changeText(getByTestId('settings-first-name'), 'Renamed');
    fireEvent.press(getByTestId('settings-save-profile'));

    // The button must not stay stuck on "Saving…" forever: the same finally
    // that guards the network path also runs for a failed enqueue.
    await waitFor(() => {
      expect(getByText(i18n.t('settings.failedUpdateProfile'))).toBeTruthy();
    });
    expect(getByText(i18n.t('settings.saveChanges'))).toBeTruthy();
    // Rolled back to the original profile since nothing was queued for replay.
    expect(setUser).toHaveBeenLastCalledWith(expect.objectContaining({ first_name: 'Alice' }));
  });

  it('re-translates the success message when the language changes', async () => {
    mockAuth(true);

    const { getByTestId, getByText } = render(<AccountSection />);
    fireEvent.changeText(getByTestId('settings-first-name'), 'Renamed');
    fireEvent.press(getByTestId('settings-save-profile'));

    await waitFor(() => {
      expect(getByText(i18n.t('settings.profileUpdated'))).toBeTruthy();
    });

    await act(async () => {
      await i18n.changeLanguage('de');
    });

    // The message is held as a translation key, so a language switch re-renders
    // it in the new language. It used to be stored pre-translated, which forced
    // an effect to clear it here rather than leave a stale English string.
    expect(getByText(i18n.t('settings.profileUpdated', { lng: 'de' }))).toBeTruthy();
  });
});
