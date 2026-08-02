import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { User } from '@jot/shared';
import { UsersProvider, useUsers } from '../src/store/UsersContext';
import { publishProfileIconUpdate } from '../src/store/profileIconEvents';
import { publishReconnectResync } from '../src/store/resyncEvents';
import { getUsers } from '../src/api/users';
import { getLocalUsers, upsertUser } from '../src/db/userQueries';
import type { TestDatabase } from './helpers/testDb';

const existingUser: User = {
  id: 'collab-1', username: 'bob', first_name: 'Bob', last_name: 'B',
  role: 'user', has_profile_icon: true, created_at: '', updated_at: '2024-01-01T00:00:00Z',
};

let mockAuthState = { user: null as User | null, isAuthenticated: true };
jest.mock('../src/store/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

let mockUsersConnected = false;
jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => ({ isConnected: mockUsersConnected }),
}));

jest.mock('../src/api/users', () => ({
  getUsers: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../src/api/client', () => ({
  getBaseUrl: () => 'http://localhost',
}));

// The user store runs for real against the test database (see helpers/testDb.ts);
// these stay spies so the two timing tests below can park a read mid-flight.
// `useSQLiteContext()` comes from the global mock and returns one stable
// database per test, which is what the db-dependent loadUsers callback needs.
jest.mock('../src/db/userQueries', () => {
  const actual = jest.requireActual('../src/db/userQueries');
  return {
    ...actual,
    getLocalUsers: jest.fn(actual.getLocalUsers),
    saveUsers: jest.fn(actual.saveUsers),
    upsertUser: jest.fn(actual.upsertUser),
  };
});

const mockRefreshIconCache = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/utils/profileIconCache', () => ({
  refreshIconCacheForUsers: (...args: unknown[]) => mockRefreshIconCache(...args),
}));

const mockGetUsers = getUsers as jest.Mock;
const mockGetLocalUsers = getLocalUsers as jest.Mock;
const mockUpsertUser = upsertUser as jest.Mock;

let db: TestDatabase;

/** Put the collaborator in local SQLite, the way a prior sync would have. */
async function seedExistingUser(): Promise<void> {
  await jest.requireActual('../src/db/userQueries').saveUsers(db, [existingUser]);
}

function Probe() {
  const { usersById } = useUsers();
  return <Text testID="icon-version">{usersById.get('collab-1')?.updated_at ?? 'none'}</Text>;
}

beforeEach(() => {
  jest.clearAllMocks();
  db = globalThis.testDb;
});

describe('UsersContext profile_icon_updated subscription', () => {
  it('applies a bus update to usersById and persists it', async () => {
    await seedExistingUser();
    const { getByTestId } = render(
      <UsersProvider>
        <Probe />
      </UsersProvider>,
    );

    // Seeded from local SQLite first.
    await waitFor(() => expect(getByTestId('icon-version').props.children).toBe('2024-01-01T00:00:00Z'));

    const updated: User = { ...existingUser, updated_at: '2024-06-06T00:00:00Z' };
    act(() => {
      publishProfileIconUpdate(updated);
    });

    // The bumped updated_at (which drives avatar cache-busting) is now in the map.
    await waitFor(() => expect(getByTestId('icon-version').props.children).toBe('2024-06-06T00:00:00Z'));
    expect(mockUpsertUser).toHaveBeenCalledWith(expect.anything(), updated);
    expect(mockRefreshIconCache).toHaveBeenCalledWith([updated], 'http://localhost');
    // The upsert really reached SQLite, so the bump survives a restart.
    await waitFor(async () =>
      expect(await db.getFirstAsync('SELECT updated_at FROM users WHERE id = ?', ['collab-1'])).toEqual({
        updated_at: '2024-06-06T00:00:00Z',
      }),
    );
  });

  it('inserts a collaborator the local store has never seen', async () => {
    // upsertUser writes a single row without reconciling the whole table, so a
    // brand-new collaborator arriving over the bus must INSERT rather than no-op.
    render(
      <UsersProvider>
        <Probe />
      </UsersProvider>,
    );
    await waitFor(() => expect(mockGetLocalUsers).toHaveBeenCalled());

    act(() => {
      publishProfileIconUpdate(existingUser);
    });

    await waitFor(async () =>
      expect(await db.getAllAsync('SELECT id, username FROM users')).toEqual([
        { id: 'collab-1', username: 'bob' },
      ]),
    );
  });
});

describe('UsersContext catch-up on SSE reconnect', () => {
  beforeEach(() => {
    mockUsersConnected = true;
    mockGetUsers.mockResolvedValue([]);
  });

  afterEach(() => {
    mockUsersConnected = false;
  });

  it('re-pulls the user list when a reconnect resync is published', async () => {
    render(
      <UsersProvider>
        <Probe />
      </UsersProvider>,
    );

    // Initial load fetches once.
    await waitFor(() => expect(mockGetUsers).toHaveBeenCalledTimes(1));

    // A reconnect (e.g. foreground after backgrounding) re-pulls collaborators so
    // profile changes / new shares that happened while the stream was down appear.
    await act(async () => {
      publishReconnectResync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockGetUsers).toHaveBeenCalledTimes(2);
  });

  it('skips a concurrent load while one is already in flight (Sync Loop Safety)', async () => {
    let resolveGet: ((users: User[]) => void) | undefined;
    mockGetUsers.mockImplementation(
      () => new Promise<User[]>((resolve) => { resolveGet = resolve; }),
    );
    render(
      <UsersProvider>
        <Probe />
      </UsersProvider>,
    );

    // The mount-time load is now in flight (getUsers pending).
    await waitFor(() => expect(mockGetUsers).toHaveBeenCalledTimes(1));

    // A resync arriving mid-flight is skipped rather than firing a second load.
    await act(async () => {
      publishReconnectResync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockGetUsers).toHaveBeenCalledTimes(1);

    // Once the in-flight load completes, a later resync runs normally.
    await act(async () => {
      resolveGet?.([]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      publishReconnectResync();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockGetUsers).toHaveBeenCalledTimes(2);
  });
});

describe('UsersContext sign-out', () => {
  beforeEach(() => {
    mockAuthState = { user: null, isAuthenticated: true };
  });

  afterEach(() => {
    mockAuthState = { user: null, isAuthenticated: true };
  });

  it('serves an empty map on the first render after sign-out', async () => {
    await seedExistingUser();

    const { getByTestId, rerender } = render(
      <UsersProvider>
        <Probe />
      </UsersProvider>,
    );

    // Loaded and visible while signed in.
    await waitFor(() => {
      expect(getByTestId('icon-version').props.children).toBe(existingUser.updated_at);
    });

    mockAuthState = { user: null, isAuthenticated: false };
    rerender(
      <UsersProvider>
        <Probe />
      </UsersProvider>,
    );

    // Masked during render, so consumers never observe the previous session's
    // collaborators — clearing this in an effect left them readable for a frame.
    expect(getByTestId('icon-version').props.children).toBe('none');
  });

  it('does not refill the cache from a local read that resolves after sign-out', async () => {
    await seedExistingUser();
    // Park the real SQLite read mid-flight so the sign-out lands while it is
    // still pending — the race this test exists for.
    let resolveLocal: ((users: User[]) => void) | undefined;
    mockGetLocalUsers.mockImplementation(
      () => new Promise<User[]>((resolve) => { resolveLocal = resolve; }),
    );

    const { getByTestId, rerender } = render(
      <UsersProvider>
        <Probe />
      </UsersProvider>,
    );

    // The mount-time load is in flight, parked on the SQLite read.
    await waitFor(() => expect(mockGetLocalUsers).toHaveBeenCalledTimes(1));

    // Sign out: the effect cleanup cancels that load, and the provider serves an
    // empty map while signed out. The provider stays mounted, so isMountedRef
    // alone wouldn't catch it.
    mockAuthState = { user: null, isAuthenticated: false };
    rerender(
      <UsersProvider>
        <Probe />
      </UsersProvider>,
    );

    await act(async () => {
      resolveLocal?.([existingUser]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The previous user's collaborators must not reappear after sign-out.
    expect(getByTestId('icon-version').props.children).toBe('none');
  });
});
