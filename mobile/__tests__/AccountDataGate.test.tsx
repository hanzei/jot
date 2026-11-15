/**
 * The gate in front of every local read and the queue drain (issue #1264,
 * spec §8.6): a signed-in user never sees, or sends, another account's data.
 */

import { useEffect } from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';
import type { User } from '@jot/shared';
import { AccountDataGate } from '../src/store/AccountDataGate';
import { claimLocalData, getAccountOwner } from '../src/db/accountOwner';
import { saveNote } from '../src/db/noteQueries';
import { makeTextNote, seedQueueEntry } from './helpers/fixtures';
import type { TestDatabase } from './helpers/testDb';
import { silenceConsole } from './helpers/consoleGuard';

interface MockAuth {
  user: Pick<User, 'id'> | null;
  userServerId: string | null;
  isLocalMode: boolean;
}

let mockAuth: MockAuth;

jest.mock('../src/store/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

jest.mock('../src/theme/ThemeContext', () => ({
  useTheme: () => ({ colors: jest.requireActual('../src/theme/colors').lightColors, isDark: false }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let db: TestDatabase;
/** What each mount of the probe read on its first look at the database. */
let firstReads: number[];

/** Stands in for the screens and the drain: records the queue it sees on mount. */
function Probe() {
  useEffect(() => {
    void db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM sync_queue').then((row) => {
      firstReads.push(row?.count ?? 0);
    });
  }, []);
  return <Text testID="probe">ready</Text>;
}

function gate() {
  return (
    <AccountDataGate serverId="server-1">
      <Probe />
    </AccountDataGate>
  );
}

const signedIn = (id: string, userServerId = 'server-1'): MockAuth => ({ user: { id }, userServerId, isLocalMode: false });

async function seedOwnedBy(owner: string): Promise<void> {
  await claimLocalData(db, owner);
  await saveNote(db, makeTextNote({ id: 'note-1' }));
  await seedQueueEntry(db, { operation: 'update', endpoint: '/notes/note-1', method: 'PATCH', body: { title: 'x' } });
}

beforeEach(() => {
  db = globalThis.testDb;
  firstReads = [];
  mockAuth = { user: null, userServerId: null, isLocalMode: false };
  silenceConsole('info', /wiped it before sign-in/);
});

describe('AccountDataGate', () => {
  it('renders straight through while signed out', async () => {
    await seedOwnedBy('user-a');

    await render(gate());

    expect(screen.getByTestId('probe')).toBeTruthy();
    expect(await getAccountOwner(db)).toBe('user-a');
  });

  it('lets the owner through with their queue intact', async () => {
    await seedOwnedBy('user-a');
    mockAuth = signedIn('user-a');

    await render(gate());

    await waitFor(() => expect(firstReads).toEqual([1]));
  });

  it('wipes another account\'s data before anything below reads it', async () => {
    await seedOwnedBy('user-a');
    mockAuth = signedIn('user-b');

    await render(gate());

    // The probe mounts once, and only after the wipe: its first read is empty.
    await waitFor(() => expect(firstReads).toEqual([0]));
    expect(await getAccountOwner(db)).toBe('user-b');
  });

  it('checks again on the next sign-in after a sign-out', async () => {
    await seedOwnedBy('user-a');
    mockAuth = signedIn('user-a');
    const view = await render(gate());
    await waitFor(() => expect(firstReads).toEqual([1]));

    mockAuth = { user: null, userServerId: null, isLocalMode: false };
    await view.rerender(gate());
    // While signed out, the data changes hands underneath (a stand-in for
    // anything that leaves it owned by someone else).
    await db.runAsync("UPDATE account_owner SET user_id = 'user-z'");

    mockAuth = signedIn('user-a');
    await view.rerender(gate());

    await waitFor(() => expect(firstReads.at(-1)).toBe(0));
    expect(await getAccountOwner(db)).toBe('user-a');
  });

  it('does not judge this database by a user from another server', async () => {
    // Right after a server switch, until revalidation replaces it.
    await seedOwnedBy('user-a');
    mockAuth = signedIn('user-on-other-server', 'server-2');

    await render(gate());

    expect(screen.getByTestId('probe')).toBeTruthy();
    await waitFor(() => expect(firstReads).toEqual([1]));
    expect(await getAccountOwner(db)).toBe('user-a');
  });

  it('never gates local mode', async () => {
    await seedOwnedBy('user-a');
    mockAuth = { user: { id: 'local-user' }, userServerId: null, isLocalMode: true };

    await render(gate());

    expect(screen.getByTestId('probe')).toBeTruthy();
    expect(await getAccountOwner(db)).toBe('user-a');
  });
});
