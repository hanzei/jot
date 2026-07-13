import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { User } from '@jot/shared';
import { UsersProvider, useUsers } from '../src/store/UsersContext';
import { publishProfileIconUpdate } from '../src/store/profileIconEvents';
import { publishReconnectResync } from '../src/store/resyncEvents';
import { getUsers } from '../src/api/users';

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

jest.mock('../src/store/AuthContext', () => ({
  useAuth: () => ({ user: null, isAuthenticated: true }),
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
});
