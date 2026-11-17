import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import AccountSection from '../src/screens/settings/AccountSection';
import { useAuth } from '../src/store/AuthContext';
import { cacheAuthProfile } from '../src/api/client';
import { enqueueSettingsUpdate } from '../src/db/syncQueue';
import i18n from '../src/i18n';
import { jot } from '../src/api/jot';

jest.mock('../src/api/jot', () => ({
  jot: {
    users: {
      updateMe: jest.fn(),
    },
  },
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));


jest.mock('../src/api/client', () => ({
  cacheAuthProfile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/db/syncQueue', () => ({
  enqueueSettingsUpdate: jest.fn().mockResolvedValue(undefined),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockUpdateMe = jest.mocked(jot.users.updateMe);
const mockCacheAuthProfile = cacheAuthProfile as jest.MockedFunction<typeof cacheAuthProfile>;
const mockEnqueueSettingsUpdate = jest.mocked(enqueueSettingsUpdate);

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
    await i18n.changeLanguage('en');
  });

  it('queues the profile change in server mode, without calling the server (#1285)', async () => {
    mockAuth(false);

    const { getByTestId, getByText } = await render(<AccountSection />);
    await fireEvent.changeText(getByTestId('settings-first-name'), 'Renamed');
    await fireEvent.press(getByTestId('settings-save-profile'));

    await waitFor(() => {
      expect(getByText(i18n.t('settings.profileUpdated'))).toBeTruthy();
    });
    expect(mockEnqueueSettingsUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ first_name: 'Renamed' }),
    );
    expect(mockUpdateMe).not.toHaveBeenCalled();
    // Server-backed updates are mirrored into the offline auth cache.
    expect(mockCacheAuthProfile).toHaveBeenCalled();
  });

  it('shows no pending state while the save is being queued', async () => {
    mockAuth(false);
    let finishEnqueue!: () => void;
    mockEnqueueSettingsUpdate.mockReturnValueOnce(new Promise<void>((resolve) => { finishEnqueue = resolve; }));

    const { getByTestId, getByText, queryByText } = await render(<AccountSection />);
    await fireEvent.changeText(getByTestId('settings-first-name'), 'Renamed');
    // Not awaited: the press resolves only once the enqueue does.
    let pressed!: Promise<unknown>;
    await act(async () => { pressed = fireEvent.press(getByTestId('settings-save-profile')); });

    // A write never shows a pending state (mobile/CLAUDE.md).
    expect(getByTestId('settings-save-profile')).not.toBeDisabled();
    expect(getByText(i18n.t('settings.saveChanges'))).toBeTruthy();
    expect(queryByText(i18n.t('settings.saving'))).toBeNull();

    await act(async () => {
      finishEnqueue();
      await pressed;
    });
    expect(getByText(i18n.t('settings.profileUpdated'))).toBeTruthy();
  });

  it('ignores a second save while the first is still being queued', async () => {
    mockAuth(false);
    let failEnqueue!: (err: Error) => void;
    mockEnqueueSettingsUpdate.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { failEnqueue = reject; }));

    const { getByTestId, getByText } = await render(<AccountSection />);
    await fireEvent.changeText(getByTestId('settings-first-name'), 'Renamed');
    // Not awaited: the press resolves only once the enqueue does.
    let pressed!: Promise<unknown>;
    await act(async () => { pressed = fireEvent.press(getByTestId('settings-save-profile')); });
    expect(mockEnqueueSettingsUpdate).toHaveBeenCalledTimes(1);

    await fireEvent.changeText(getByTestId('settings-first-name'), 'Renamed again');
    await fireEvent.press(getByTestId('settings-save-profile'));
    // The second tap is ignored rather than racing the first: a failure of
    // the first would roll back to the profile captured at its tap and so
    // overwrite the second save.
    expect(mockEnqueueSettingsUpdate).toHaveBeenCalledTimes(1);
    // Still no visible pending state.
    expect(getByTestId('settings-save-profile')).not.toBeDisabled();

    await act(async () => {
      failEnqueue(new Error('sqlite write failed'));
      await pressed;
    });
    expect(getByText(i18n.t('settings.failedUpdateProfile'))).toBeTruthy();

    // Once the first save has settled, a tap saves again.
    await fireEvent.press(getByTestId('settings-save-profile'));
    await waitFor(() => {
      expect(getByText(i18n.t('settings.profileUpdated'))).toBeTruthy();
    });
    expect(mockEnqueueSettingsUpdate).toHaveBeenCalledTimes(2);
    expect(mockEnqueueSettingsUpdate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ first_name: 'Renamed again' }),
    );
  });

  it('does not touch the server or sync queue in local mode', async () => {
    mockAuth(true);

    const { getByTestId, getByText } = await render(<AccountSection />);
    await fireEvent.changeText(getByTestId('settings-first-name'), 'Renamed');
    await fireEvent.press(getByTestId('settings-save-profile'));

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
    expect(mockEnqueueSettingsUpdate).not.toHaveBeenCalled();
    expect(mockCacheAuthProfile).not.toHaveBeenCalled();
  });

  it('rolls back when the local enqueue itself fails', async () => {
    mockAuth(false);
    mockEnqueueSettingsUpdate.mockRejectedValueOnce(new Error('sqlite write failed'));

    const { getByTestId, getByText } = await render(<AccountSection />);
    await fireEvent.changeText(getByTestId('settings-first-name'), 'Renamed');
    await fireEvent.press(getByTestId('settings-save-profile'));

    await waitFor(() => {
      expect(getByText(i18n.t('settings.failedUpdateProfile'))).toBeTruthy();
    });
    expect(getByText(i18n.t('settings.saveChanges'))).toBeTruthy();
    // Rolled back to the original profile since nothing was queued for replay.
    expect(setUser).toHaveBeenLastCalledWith(expect.objectContaining({ first_name: 'Alice' }));
  });

  it('re-translates the success message when the language changes', async () => {
    mockAuth(true);

    const { getByTestId, getByText } = await render(<AccountSection />);
    await fireEvent.changeText(getByTestId('settings-first-name'), 'Renamed');
    await fireEvent.press(getByTestId('settings-save-profile'));

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
