import * as SecureStore from 'expo-secure-store';
import {
  disableLocalMode,
  enableLocalMode,
  getLocalIdentity,
  isLocalModeEnabled,
  updateLocalSettings,
  updateLocalUser,
} from '../src/store/localMode';

const mockSecureStore = SecureStore as unknown as {
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
};

const LOCAL_MODE_KEY = 'jot_local_mode_v1';

describe('localMode store', () => {
  const memory = new Map<string, string>();

  beforeEach(() => {
    memory.clear();
    jest.clearAllMocks();
    mockSecureStore.getItemAsync.mockImplementation(async (key: string) => memory.get(key) ?? null);
    mockSecureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
      memory.set(key, value);
    });
    mockSecureStore.deleteItemAsync.mockImplementation(async (key: string) => {
      memory.delete(key);
    });
  });

  it('reports local mode disabled when nothing is persisted', async () => {
    expect(await isLocalModeEnabled()).toBe(false);
    expect(await getLocalIdentity()).toBeNull();
  });

  it('enableLocalMode provisions and persists a valid identity', async () => {
    const identity = await enableLocalMode();

    expect(identity.user.id).toHaveLength(22);
    expect(identity.user.username).toBe('local');
    expect(identity.user.role).toBe('user');
    expect(identity.settings.user_id).toBe(identity.user.id);
    expect(identity.settings.theme).toBe('system');
    expect(memory.has(LOCAL_MODE_KEY)).toBe(true);

    expect(await isLocalModeEnabled()).toBe(true);
    expect(await getLocalIdentity()).toEqual(identity);
  });

  it('enableLocalMode is idempotent and preserves the existing identity', async () => {
    const first = await enableLocalMode();
    const second = await enableLocalMode();

    expect(second).toEqual(first);
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it('disableLocalMode drops the persisted identity', async () => {
    await enableLocalMode();
    await disableLocalMode();

    expect(await isLocalModeEnabled()).toBe(false);
    expect(await getLocalIdentity()).toBeNull();
  });

  it('updateLocalUser persists profile edits without disturbing settings', async () => {
    const identity = await enableLocalMode();

    const renamed = { ...identity.user, first_name: 'Renamed', last_name: 'User' };
    await updateLocalUser(renamed);

    const stored = await getLocalIdentity();
    expect(stored?.user).toEqual(renamed);
    expect(stored?.settings).toEqual(identity.settings);
  });

  it('updateLocalUser and updateLocalSettings do not clobber each other', async () => {
    const identity = await enableLocalMode();

    await Promise.all([
      updateLocalUser({ ...identity.user, first_name: 'Renamed' }),
      updateLocalSettings({ ...identity.settings, language: 'de' }),
    ]);

    const stored = await getLocalIdentity();
    expect(stored?.user.first_name).toBe('Renamed');
    expect(stored?.settings.language).toBe('de');
  });

  it('updateLocalUser is a no-op when local mode is disabled', async () => {
    await updateLocalUser({
      id: 'x', username: 'local', first_name: '', last_name: '',
      role: 'user', has_profile_icon: false, created_at: '', updated_at: '',
    });
    expect(await getLocalIdentity()).toBeNull();
  });

  it('treats a corrupt persisted record as disabled', async () => {
    memory.set(LOCAL_MODE_KEY, '{ not valid json');
    expect(await getLocalIdentity()).toBeNull();

    memory.set(LOCAL_MODE_KEY, JSON.stringify({ user: { id: 1 }, settings: {} }));
    expect(await getLocalIdentity()).toBeNull();
  });
});
