/**
 * "Delete account" in the account card (#1317): hidden in local mode, the
 * confirmation's warnings and confirmation field, each error, and the success
 * path, which wipes local data and ends the session without `POST /logout`,
 * keeping the server in the server list. Real SQLite underneath.
 */

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { User } from '@jot/shared';
import AccountSection from '../src/screens/settings/AccountSection';
import { useAuth } from '../src/store/AuthContext';
import { jot } from '../src/api/jot';
import * as accountDeletion from '../src/store/accountDeletion';
import { removeServer } from '../src/store/serverAccounts';
import { markServerReachable, markServerUnreachable } from '../src/api/serverReachability';
import { claimLocalData, getAccountOwner } from '../src/db/accountOwner';
import { saveNote } from '../src/db/noteQueries';
import i18n from '../src/i18n';
import { makeTextNote, remainingQueueIds, seedImageUpload, seedQueueEntry } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/api/jot', () => ({
  jot: { users: { deleteMe: jest.fn(), updateMe: jest.fn() } },
}));

jest.mock('../src/api/client', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
  cacheAuthProfile: jest.fn().mockResolvedValue(undefined),
  getActiveServerId: jest.fn(() => 'server-1'),
  isServerSwitchInProgress: jest.fn(() => false),
  clearStoredSession: jest.fn(async () => undefined),
}));

jest.mock('../src/store/serverAccounts', () => ({
  removeServer: jest.fn(),
}));

jest.mock('../src/hooks/useServerConfig', () => ({
  useServerConfig: () => ({ sso: { enabled: true, local_login_enabled: true, provider_name: 'Acme ID' } }),
}));

let mockIsConnected = true;
jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => ({ isConnected: mockIsConnected }),
}));

const mockUseAuth = jest.mocked(useAuth);
const mockDeleteMe = jest.mocked(jot.users.deleteMe);
const mockRemoveServer = jest.mocked(removeServer);
const mockEndSessionLocally = jest.fn(async () => undefined);
const mockLogout = jest.fn(async () => undefined);

const baseUser: User = {
  id: 'user-1',
  username: 'alice',
  first_name: 'Alice',
  last_name: '',
  role: 'user',
  has_profile_icon: false,
  has_password: true,
  has_sso_linked: false,
  created_at: '',
  updated_at: '',
} as User;

function mockAuth(overrides: { isLocalMode?: boolean; user?: Partial<User> } = {}) {
  mockUseAuth.mockImplementation(() => ({
    user: { ...baseUser, ...overrides.user },
    settings: { user_id: 'user-1', language: 'en', theme: 'system', note_sort: 'manual', updated_at: '' },
    setUser: jest.fn(),
    setSettings: jest.fn(),
    isLocalMode: overrides.isLocalMode ?? false,
    endSessionLocally: mockEndSessionLocally,
    logout: mockLogout,
  }) as unknown as ReturnType<typeof useAuth>);
}

function apiError(status: number, code: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: { error: { code, message: `server says ${code}` } } },
  });
}

let db: TestDatabase;
// The queue rows a test seeded; anything else in the queue was created by the code under test.
let seededQueueIds: number[];

async function seedQueued(): Promise<number> {
  const id = await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/note-1', method: 'PATCH', body: { title: 'x' } });
  seededQueueIds.push(id);
  return id;
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockIsConnected = true;
  markServerReachable();
  await i18n.changeLanguage('en');
  db = globalThis.testDb;
  globalThis.mockFileSystem.reset();
  await claimLocalData(db, 'user-1', 'server-1');
  await saveNote(db, makeTextNote({ id: 'note-1' }));
  seededQueueIds = [];
});

afterEach(async () => {
  // Nothing about deleting the account goes through the outbox (spec §4.3).
  for (const id of await remainingQueueIds(db)) expect(seededQueueIds).toContain(id);
});

async function openDialog() {
  const screen = await render(<AccountSection />);
  await fireEvent.press(screen.getByTestId('settings-delete-account'));
  await waitFor(() => expect(screen.getByTestId('settings-delete-account-dialog')).toBeTruthy());
  return screen;
}

async function confirmWith(screen: Awaited<ReturnType<typeof openDialog>>, testID: string, value: string) {
  await fireEvent.changeText(screen.getByTestId(testID), value);
  await fireEvent.press(screen.getByTestId('settings-delete-account-confirm'));
}

describe('Delete account', () => {
  it('is not offered in local mode', async () => {
    mockAuth({ isLocalMode: true });
    const { queryByTestId } = await render(<AccountSection />);
    expect(queryByTestId('settings-delete-account')).toBeNull();
  });

  it('asks for the password on an account that has one, with no SSO note when unlinked', async () => {
    mockAuth();
    const screen = await openDialog();

    expect(screen.getByText(i18n.t('settings.deleteAccountConfirmMessage'))).toBeTruthy();
    expect(screen.getByTestId('settings-delete-account-password')).toBeTruthy();
    expect(screen.queryByTestId('settings-delete-account-username')).toBeNull();
    expect(screen.queryByTestId('settings-delete-account-sso-note')).toBeNull();
    expect(screen.queryByTestId('settings-delete-account-unsynced')).toBeNull();
    // Nothing typed yet: nothing to send.
    expect(screen.getByTestId('settings-delete-account-confirm')).toBeDisabled();
  });

  it('asks for the username on an account without a password, and warns an SSO user about re-provisioning', async () => {
    mockAuth({ user: { has_password: false, has_sso_linked: true } });
    const screen = await openDialog();

    expect(screen.getByTestId('settings-delete-account-username')).toBeTruthy();
    expect(screen.queryByTestId('settings-delete-account-password')).toBeNull();
    expect(screen.getByText(i18n.t('settings.deleteAccountUsernameLabel', { username: 'alice' }))).toBeTruthy();
    expect(screen.getByTestId('settings-delete-account-sso-note')).toHaveTextContent(
      i18n.t('settings.deleteAccountSsoNote', { provider: 'Acme ID' }),
    );

    mockDeleteMe.mockResolvedValueOnce(undefined);
    await confirmWith(screen, 'settings-delete-account-username', ' alice ');
    await waitFor(() => expect(mockEndSessionLocally).toHaveBeenCalled());
    expect(mockDeleteMe).toHaveBeenCalledWith({ username: 'alice' });
  });

  it('says how many unsynced changes would be lost', async () => {
    mockAuth();
    await seedQueued();
    await seedImageUpload(db, { note_id: 'note-1', status: 'error' });

    const screen = await openDialog();

    expect(screen.getByTestId('settings-delete-account-unsynced')).toHaveTextContent(
      i18n.t('settings.deleteAccountUnsynced', { count: 2 }),
    );
  });

  it('deletes, wipes local data, then ends the session without logging out or forgetting the server', async () => {
    mockAuth();
    const queued = await seedQueued();
    expect(await remainingQueueIds(db)).toEqual([queued]);
    let resolveDelete!: () => void;
    mockDeleteMe.mockReturnValueOnce(new Promise<void>((resolve) => { resolveDelete = resolve; }));
    const ownerAtEnd: (string | null)[] = [];
    mockEndSessionLocally.mockImplementationOnce(async () => {
      ownerAtEnd.push(await getAccountOwner(db));
    });

    const screen = await openDialog();
    await fireEvent.changeText(screen.getByTestId('settings-delete-account-password'), 'secret');
    // Not awaited: the press resolves only once the deletion does.
    let pressed!: Promise<unknown>;
    await act(async () => { pressed = fireEvent.press(screen.getByTestId('settings-delete-account-confirm')); });

    // A visible pending state while the request runs.
    await waitFor(() => expect(screen.getByTestId('settings-delete-account-spinner')).toBeTruthy());
    expect(screen.getByTestId('settings-delete-account-confirm')).toBeDisabled();
    expect(screen.getByTestId('settings-delete-account-cancel')).toBeDisabled();
    expect(mockDeleteMe).toHaveBeenCalledWith({ current_password: 'secret' });

    await act(async () => {
      resolveDelete();
      await pressed;
    });
    expect(mockEndSessionLocally).toHaveBeenCalledTimes(1);

    expect(ownerAtEnd).toEqual(['']);
    expect(await remainingQueueIds(db)).toEqual([]);
    const notes = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM notes');
    expect(notes?.count).toBe(0);
    expect(mockLogout).not.toHaveBeenCalled();
    expect(mockRemoveServer).not.toHaveBeenCalled();
  });

  it('shows a wrong password on the field and keeps everything', async () => {
    mockAuth();
    mockDeleteMe.mockRejectedValueOnce(apiError(403, 'incorrect_password'));
    const screen = await openDialog();

    await confirmWith(screen, 'settings-delete-account-password', 'wrong');

    await waitFor(() => expect(screen.getByTestId('settings-delete-account-field-error')).toHaveTextContent(
      i18n.t('apiErrors.incorrectPassword'),
    ));
    expect(screen.queryByTestId('settings-delete-account-error')).toBeNull();
    expect(mockEndSessionLocally).not.toHaveBeenCalled();
    expect(await getAccountOwner(db)).toBe('user-1');
  });

  it('clears a wrong password from the field once the user edits it', async () => {
    mockAuth();
    mockDeleteMe.mockRejectedValueOnce(apiError(403, 'incorrect_password'));
    const screen = await openDialog();
    await confirmWith(screen, 'settings-delete-account-password', 'wrong');
    await waitFor(() => expect(screen.getByTestId('settings-delete-account-field-error')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('settings-delete-account-password'), 'wrong2');

    expect(screen.queryByTestId('settings-delete-account-field-error')).toBeNull();
  });

  it('shows a wrong username on the field', async () => {
    mockAuth({ user: { has_password: false } });
    mockDeleteMe.mockRejectedValueOnce(apiError(403, 'incorrect_username'));
    const screen = await openDialog();

    await confirmWith(screen, 'settings-delete-account-username', 'bob');

    await waitFor(() => expect(screen.getByTestId('settings-delete-account-field-error')).toHaveTextContent(
      i18n.t('settings.deleteAccountIncorrectUsername'),
    ));
    expect(mockEndSessionLocally).not.toHaveBeenCalled();
  });

  it('explains that the only admin must promote someone first', async () => {
    mockAuth({ user: { role: 'admin' } });
    mockDeleteMe.mockRejectedValueOnce(apiError(409, 'last_admin'));
    const screen = await openDialog();

    await confirmWith(screen, 'settings-delete-account-password', 'secret');

    await waitFor(() => expect(screen.getByTestId('settings-delete-account-error')).toHaveTextContent(
      i18n.t('settings.deleteAccountLastAdmin'),
    ));
    expect(screen.queryByTestId('settings-delete-account-field-error')).toBeNull();
    expect(mockEndSessionLocally).not.toHaveBeenCalled();
    expect(await getAccountOwner(db)).toBe('user-1');
  });

  it("shows the server's message for any other refusal", async () => {
    mockAuth();
    mockDeleteMe.mockRejectedValueOnce(apiError(403, 'session_required'));
    const screen = await openDialog();

    await confirmWith(screen, 'settings-delete-account-password', 'secret');

    await waitFor(() => expect(screen.getByTestId('settings-delete-account-error')).toHaveTextContent(
      'server says session_required',
    ));
    expect(mockEndSessionLocally).not.toHaveBeenCalled();
  });

  it('says the outcome is unknown when the request gets no answer, since the server may have deleted it', async () => {
    mockAuth();
    mockDeleteMe.mockImplementationOnce(async () => {
      // What the API client's interceptor does on a request with no response.
      markServerUnreachable();
      throw Object.assign(new Error('timeout of 15000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' });
    });
    const screen = await openDialog();

    await confirmWith(screen, 'settings-delete-account-password', 'secret');

    await waitFor(() => expect(screen.getByTestId('settings-delete-account-error')).toHaveTextContent(
      i18n.t('settings.deleteAccountUnconfirmed'),
    ));
    expect(mockEndSessionLocally).not.toHaveBeenCalled();
    expect(await getAccountOwner(db)).toBe('user-1');
  });

  it.each([
    ['unreachable', 'settings.deleteAccountUnreachable'],
    ['server_changed', 'settings.deleteAccountFailed'],
  ] as const)('says the account was not deleted when the request was not sent (%s)', async (reason, key) => {
    mockAuth();
    jest.spyOn(accountDeletion, 'deleteAccount').mockRejectedValueOnce(new accountDeletion.AccountDeletionNotSentError(reason));
    const screen = await openDialog();

    await confirmWith(screen, 'settings-delete-account-password', 'secret');

    await waitFor(() => expect(screen.getByTestId('settings-delete-account-error')).toHaveTextContent(i18n.t(key)));
    expect(mockEndSessionLocally).not.toHaveBeenCalled();
  });

  it('does not send the request while the server is known to be unreachable', async () => {
    mockAuth();
    markServerUnreachable();
    const screen = await openDialog();

    await confirmWith(screen, 'settings-delete-account-password', 'secret');

    expect(screen.getByTestId('settings-delete-account-error')).toHaveTextContent(
      i18n.t('settings.deleteAccountUnreachable'),
    );
    expect(mockDeleteMe).not.toHaveBeenCalled();
  });

  it('does not send the request while the device is offline', async () => {
    mockAuth();
    mockIsConnected = false;
    const screen = await openDialog();

    await confirmWith(screen, 'settings-delete-account-password', 'secret');

    expect(screen.getByTestId('settings-delete-account-error')).toHaveTextContent(
      i18n.t('settings.deleteAccountUnreachable'),
    );
    expect(mockDeleteMe).not.toHaveBeenCalled();
  });

  it('closes on cancel without deleting anything', async () => {
    mockAuth();
    const screen = await openDialog();

    await fireEvent.press(screen.getByTestId('settings-delete-account-cancel'));

    await waitFor(() => expect(screen.queryByTestId('settings-delete-account-dialog')).toBeNull());
    expect(mockDeleteMe).not.toHaveBeenCalled();
    expect(await getAccountOwner(db)).toBe('user-1');
  });
});
