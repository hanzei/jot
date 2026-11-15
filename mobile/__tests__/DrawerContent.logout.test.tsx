/**
 * Logout from the drawer (issue #1264, spec §8.6): a server-account logout
 * wipes the local data, and the confirmation says how many changes would be
 * lost when any have not synced. Local mode is untouched.
 */

import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { DrawerContentComponentProps } from '@react-navigation/drawer';
import DrawerContent from '../src/components/DrawerContent';
import { ConfirmContext, type ConfirmOptions } from '../src/hooks/useConfirm';
import { claimLocalData, getAccountOwner } from '../src/db/accountOwner';
import { saveNote } from '../src/db/noteQueries';
import { makeTextNote, seedImageUpload, seedQueueEntry } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';

const mockLogout = jest.fn(async () => undefined);
let mockIsLocalMode = false;

jest.mock('../src/store/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', username: 'alice', first_name: '', last_name: '', role: 'user', has_profile_icon: false, created_at: '', updated_at: '' },
    isLocalMode: mockIsLocalMode,
    logout: mockLogout,
    clearAuth: jest.fn(),
    revalidateSession: jest.fn(async () => true),
  }),
}));

jest.mock('../src/components/UserAvatar', () => ({ __esModule: true, default: () => null }));

jest.mock('../src/hooks/useLabels', () => ({
  useLabels: () => ({ data: [] }),
  useCreateLabel: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRenameLabel: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeleteLabel: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock('../src/theme/ThemeContext', () => ({
  useTheme: () => ({ colors: jest.requireActual('../src/theme/colors').lightColors, isDark: false }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@react-navigation/native', () => ({
  CommonActions: { navigate: jest.fn((payload) => payload) },
}));

jest.mock('../src/api/client', () => ({
  switchActiveServer: jest.fn(),
  getBaseUrl: jest.fn(() => 'http://localhost:8080'),
  getStoredServerUrl: jest.fn(async () => null),
}));

jest.mock('../src/store/serverAccounts', () => ({
  listServers: jest.fn(async () => []),
  getActiveServer: jest.fn(async () => null),
  addServer: jest.fn(),
}));

jest.mock('@react-navigation/drawer', () => {
  const { View } = jest.requireActual('react-native');
  const ReactLocal = jest.requireActual('react');
  return {
    DrawerContentScrollView: (props: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactLocal.createElement(View, props, props.children),
  };
});

const props = {
  state: { index: 0, key: 'drawer', routeNames: ['Notes'], routes: [{ key: 'notes', name: 'Notes' }], stale: false, type: 'drawer', history: [] },
  navigation: { navigate: jest.fn(), closeDrawer: jest.fn(), dispatch: jest.fn() },
  descriptors: {},
} as unknown as DrawerContentComponentProps;

let db: TestDatabase;

async function pressLogout(answer: boolean): Promise<ConfirmOptions> {
  const confirm = jest.fn(async (_options: ConfirmOptions) => answer);
  const { getByTestId } = await render(
    <ConfirmContext.Provider value={{ confirm }}>
      <DrawerContent {...props} />
    </ConfirmContext.Provider>,
  );
  await fireEvent.press(getByTestId('drawer-logout'));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  return confirm.mock.calls[0]![0];
}

async function noteCount(): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM notes');
  return row?.count ?? 0;
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockIsLocalMode = false;
  db = globalThis.testDb;
  globalThis.mockFileSystem.reset();
  await claimLocalData(db, 'user-1');
  await saveNote(db, makeTextNote({ id: 'note-1' }));
});

describe('DrawerContent logout', () => {
  it('keeps the plain confirmation when nothing is unsynced, and wipes after logout', async () => {
    const options = await pressLogout(true);

    expect(options.message).toBe('nav.logoutConfirmMessage');
    await waitFor(async () => expect(await getAccountOwner(db)).toBe(''));
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(await noteCount()).toBe(0);
  });

  it('says how many changes are unsynced before the user commits', async () => {
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/note-1', method: 'PATCH', body: { title: 'x' } });
    await seedImageUpload(db, { note_id: 'note-1' });

    const options = await pressLogout(true);

    expect(options.message).toBe('nav.logoutUnsyncedMessage:2');
    await waitFor(async () => expect(await getAccountOwner(db)).toBe(''));
    expect(await noteCount()).toBe(0);
  });

  it('neither logs out nor wipes when the user cancels', async () => {
    await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/note-1', method: 'PATCH', body: { title: 'x' } });

    await pressLogout(false);

    expect(mockLogout).not.toHaveBeenCalled();
    expect(await getAccountOwner(db)).toBe('user-1');
    expect(await noteCount()).toBe(1);
  });

  it('leaves local-mode data alone', async () => {
    mockIsLocalMode = true;

    const options = await pressLogout(true);

    expect(options.message).toBe('nav.logoutConfirmMessage');
    await waitFor(() => expect(mockLogout).toHaveBeenCalledTimes(1));
    expect(await noteCount()).toBe(1);
    expect(await getAccountOwner(db)).toBe('user-1');
  });
});
