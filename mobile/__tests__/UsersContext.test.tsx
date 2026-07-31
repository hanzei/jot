import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { User } from '@jot/shared';
import { UsersProvider, useUsers } from '../src/store/UsersContext';
import { publishProfileIconUpdate } from '../src/store/profileIconEvents';
import { publishReconnectResync } from '../src/store/resyncEvents';
import { getUsers } from '../src/api/users';
import { getLocalUsers } from '../src/db/userQueries';

const existingUser: User = {
  id: 'collab-1', username: 'bob', first_name: 'Bob', last_name: 'B',
  role: 'user', has_profile_icon: true, created_at: '', updated_at: '2024-01-01T00:00:00Z',
};

jest.mock('expo-sqlite', () => {
  // Stable reference across renders, mirroring the real provider — a fresh object
  // each render would churn the db-dependent loadUsers callback and its effects.
  const db = { runAsync: jest.fn().mockResolvedValue(undefined) };
  return { useSQLiteContext: jest.fn(() => db) };
});

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

const mockUpsertUser = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/db/userQueries', () => ({
  getLocalUsers: jest.fn(() => Promise.resolve([existingUser])),
  saveUsers: jest.fn().mockResolvedValue(undefined),
  upsertUser: (...args: unknown[]) => mockUpsertUser(...args),
}));

const mockRefreshIconCache = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/utils/profileIconCache', () => ({
  refreshIconCacheForUsers: (...args: unknown[]) => mockRefreshIconCache(...args),
}));

const mockGetUsers = getUsers as jest.Mock;
const mockGetLocalUsers = getLocalUsers as jest.Mock;

function Probe() {
  const { usersById } = useUsers();
  return <Text testID="icon-version">{usersById.get('collab-1')?.updated_at ?? 'none'}</Text>;
}

describe('UsersContext profile_icon_updated subscription', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('applies a bus update to usersById and persists it', async () => {
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
  });
});

describe('UsersContext catch-up on SSE reconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    jest.clearAllMocks();
    mockAuthState = { user: null, isAuthenticated: true };
  });

  afterEach(() => {
    mockAuthState = { user: null, isAuthenticated: true };
    mockGetLocalUsers.mockImplementation(() => Promise.resolve([existingUser]));
  });

  it('does not refill the cache from a local read that resolves after sign-out', async () => {
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

    // Sign out: the effect cleanup cancels that load and the re-run empties the
    // cache. The provider stays mounted, so isMountedRef alone wouldn't catch it.
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
