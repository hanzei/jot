/**
 * Tests for ShareScreen's user-search connectivity handling (issue #717):
 * the online-but-server-down path must fall back to the local user filter
 * immediately instead of eating the full request timeout and surfacing a
 * hard error.
 *
 * Also covers the empty-query suggestions, which are derived from locally
 * persisted share records and so must work on the same offline paths.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import ShareScreen from '../src/screens/ShareScreen';
import { searchUsers } from '../src/api/users';
import { useNoteShares, useShareNote, useUnshareNote } from '../src/hooks/useNotes';
import { useNetworkStatus } from '../src/hooks/useNetworkStatus';
import { useUsers } from '../src/store/UsersContext';
import { useAuth } from '../src/store/AuthContext';
import { getLocalShareHistory } from '../src/db/noteQueries';
import { isServerReachable } from '../src/api/serverReachability';
import type { NoteShare, User } from '@jot/shared';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
  useRoute: () => ({ params: { noteId: 'note-1' } }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { createContext } = jest.requireActual<typeof import('react')>('react');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    __esModule: true,
    SafeAreaInsetsContext: createContext(insets),
  };
});

jest.mock('../src/api/users', () => ({
  searchUsers: jest.fn(),
}));

jest.mock('../src/hooks/useNotes', () => ({
  useNoteShares: jest.fn(),
  useShareNote: jest.fn(),
  useUnshareNote: jest.fn(),
}));

jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: jest.fn(),
}));

jest.mock('../src/store/UsersContext', () => ({
  useUsers: jest.fn(),
}));

jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../src/db/noteQueries', () => ({
  getLocalShareHistory: jest.fn(),
}));

jest.mock('../src/api/serverReachability', () => ({
  isServerReachable: jest.fn(),
}));

const mockSearchUsers = searchUsers as jest.MockedFunction<typeof searchUsers>;
const mockUseNoteShares = useNoteShares as jest.MockedFunction<typeof useNoteShares>;
const mockUseShareNote = useShareNote as jest.MockedFunction<typeof useShareNote>;
const mockUseUnshareNote = useUnshareNote as jest.MockedFunction<typeof useUnshareNote>;
const mockUseNetworkStatus = useNetworkStatus as jest.MockedFunction<typeof useNetworkStatus>;
const mockUseUsers = useUsers as jest.MockedFunction<typeof useUsers>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockGetLocalShareHistory = getLocalShareHistory as jest.MockedFunction<typeof getLocalShareHistory>;
const mockIsServerReachable = isServerReachable as jest.MockedFunction<typeof isServerReachable>;

function makeUser(overrides: Partial<User> & { id: string; username: string }): User {
  return {
    first_name: '',
    last_name: '',
    role: 'user',
    has_profile_icon: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const localUser = makeUser({
  id: 'user-local',
  username: 'localmatch',
  first_name: 'Local',
  last_name: 'Match',
});

const signedInUser = makeUser({ id: 'user-me', username: 'me', first_name: 'Me', last_name: 'Myself' });

function shareRecord(sharedWithUserId: string, createdAt: string, sharedBy = signedInUser.id): NoteShare {
  return {
    id: `share-${sharedWithUserId}`,
    note_id: 'note-1',
    shared_with_user_id: sharedWithUserId,
    shared_by_user_id: sharedBy,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function renderShareScreen() {
  return render(<ShareScreen />);
}

describe('ShareScreen user search connectivity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseNoteShares.mockReturnValue({ data: [], isLoading: false, isError: false } as never);
    mockUseShareNote.mockReturnValue({ mutateAsync: jest.fn() } as never);
    mockUseUnshareNote.mockReturnValue({ mutateAsync: jest.fn(), isPending: false } as never);
    mockUseUsers.mockReturnValue({
      usersById: new Map([[localUser.id, localUser]]),
      refreshUsers: jest.fn(),
    } as never);
    mockUseAuth.mockReturnValue({ user: signedInUser } as never);
    mockGetLocalShareHistory.mockResolvedValue([]);
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockIsServerReachable.mockReturnValue(true);
  });

  it('falls back to the local filter immediately when the server is known-unreachable, without an error', async () => {
    mockIsServerReachable.mockReturnValue(false);

    renderShareScreen();
    fireEvent.changeText(screen.getByTestId('share-search-input'), 'local');

    await waitFor(() => {
      expect(screen.getByText('@localmatch')).toBeTruthy();
    });
    expect(mockSearchUsers).not.toHaveBeenCalled();
    expect(screen.queryByText('Search failed. Please try again.')).toBeNull();
  });

  it('searches the server when online and the server is reachable', async () => {
    mockSearchUsers.mockResolvedValue([
      { ...localUser, id: 'user-remote', username: 'remotematch' },
    ]);

    renderShareScreen();
    fireEvent.changeText(screen.getByTestId('share-search-input'), 'remote');

    await waitFor(() => {
      expect(mockSearchUsers).toHaveBeenCalledWith('remote');
    });
    await waitFor(() => {
      expect(screen.getByText('@remotematch')).toBeTruthy();
    });
  });

  it('falls back to the local filter (not an error) when a search request fails against a now-unreachable server', async () => {
    mockSearchUsers.mockImplementation(() => {
      // The client's response interceptor would have already flipped
      // reachability to false by the time the catch handler runs.
      mockIsServerReachable.mockReturnValue(false);
      return Promise.reject(new Error('network error'));
    });

    renderShareScreen();
    fireEvent.changeText(screen.getByTestId('share-search-input'), 'local');

    await waitFor(() => {
      expect(screen.getByText('@localmatch')).toBeTruthy();
    });
    expect(screen.queryByText('Search failed. Please try again.')).toBeNull();
  });

  it('still surfaces a genuine error when the request fails but the server remains reachable', async () => {
    mockSearchUsers.mockRejectedValue(new Error('boom'));

    renderShareScreen();
    fireEvent.changeText(screen.getByTestId('share-search-input'), 'remote');

    await waitFor(() => {
      expect(screen.getByText('Search failed. Please try again.')).toBeTruthy();
    });
  });

  it('uses the local filter when the device is offline, regardless of server reachability', async () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false });

    renderShareScreen();
    fireEvent.changeText(screen.getByTestId('share-search-input'), 'local');

    await waitFor(() => {
      expect(screen.getByText('@localmatch')).toBeTruthy();
    });
    expect(mockSearchUsers).not.toHaveBeenCalled();
  });
});

describe('ShareScreen empty-query suggestions', () => {
  const bob = makeUser({ id: 'user-bob', username: 'bob', first_name: 'Bob', last_name: 'Jones' });
  const carol = makeUser({ id: 'user-carol', username: 'carol', first_name: 'Carol', last_name: 'King' });
  const dave = makeUser({ id: 'user-dave', username: 'dave', first_name: 'Dave', last_name: 'Adams' });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseNoteShares.mockReturnValue({ data: [], isLoading: false, isError: false } as never);
    mockUseShareNote.mockReturnValue({ mutateAsync: jest.fn() } as never);
    mockUseUnshareNote.mockReturnValue({ mutateAsync: jest.fn(), isPending: false } as never);
    mockUseUsers.mockReturnValue({
      // As in the real provider, the map is seeded with the signed-in user.
      usersById: new Map([signedInUser, bob, carol, dave].map((u) => [u.id, u])),
      refreshUsers: jest.fn(),
    } as never);
    mockUseAuth.mockReturnValue({ user: signedInUser } as never);
    mockGetLocalShareHistory.mockResolvedValue([]);
    mockUseNetworkStatus.mockReturnValue({ isConnected: true });
    mockIsServerReachable.mockReturnValue(true);
  });

  it('offers past collaborators before anything is typed, most recent first', async () => {
    mockGetLocalShareHistory.mockResolvedValue([
      { shared_with: [shareRecord(carol.id, '2026-02-01T00:00:00Z')] },
      { shared_with: [shareRecord(bob.id, '2026-05-01T00:00:00Z')] },
    ]);

    renderShareScreen();

    await waitFor(() => expect(screen.getByTestId('share-recent-suggestions')).toBeTruthy());

    const recent = screen.getByTestId('share-recent-suggestions');
    expect(within(recent).getByText('@bob')).toBeTruthy();
    expect(within(recent).getByText('@carol')).toBeTruthy();
    // Dave has no share history, so he only appears under "All users".
    expect(within(recent).queryByText('@dave')).toBeNull();
    expect(within(screen.getByTestId('share-all-users')).getByText('@dave')).toBeTruthy();
    expect(mockSearchUsers).not.toHaveBeenCalled();
  });

  it('never offers the signed-in user as a share target', async () => {
    renderShareScreen();

    await waitFor(() => expect(screen.getByTestId('share-all-users')).toBeTruthy());

    expect(screen.queryByText('@me')).toBeNull();
  });

  it('excludes collaborators the note is already shared with', async () => {
    mockUseNoteShares.mockReturnValue({
      data: [shareRecord(bob.id, '2026-05-01T00:00:00Z')],
      isLoading: false,
      isError: false,
    } as never);
    mockGetLocalShareHistory.mockResolvedValue([
      { shared_with: [shareRecord(bob.id, '2026-05-01T00:00:00Z')] },
    ]);

    renderShareScreen();

    await waitFor(() => expect(screen.getByTestId('share-all-users')).toBeTruthy());

    expect(screen.queryByTestId('share-recent-suggestions')).toBeNull();
    expect(within(screen.getByTestId('share-all-users')).queryByText('@bob')).toBeNull();
  });

  it('ignores shares created by someone else', async () => {
    mockGetLocalShareHistory.mockResolvedValue([
      { shared_with: [shareRecord(bob.id, '2026-05-01T00:00:00Z', 'another-owner')] },
    ]);

    renderShareScreen();

    await waitFor(() => expect(screen.getByTestId('share-all-users')).toBeTruthy());

    expect(screen.queryByTestId('share-recent-suggestions')).toBeNull();
  });

  it('explains an empty list when everyone already has access', async () => {
    mockUseNoteShares.mockReturnValue({
      data: [bob, carol, dave].map((u) => shareRecord(u.id, '2026-05-01T00:00:00Z')),
      isLoading: false,
      isError: false,
    } as never);

    renderShareScreen();

    await waitFor(() => {
      expect(screen.getByText('Everyone already has access to this note.')).toBeTruthy();
    });
  });

  it('explains an empty list on a single-user instance', async () => {
    mockUseUsers.mockReturnValue({
      usersById: new Map([[signedInUser.id, signedInUser]]),
      refreshUsers: jest.fn(),
    } as never);

    renderShareScreen();

    await waitFor(() => {
      expect(screen.getByText('There are no other users to share with.')).toBeTruthy();
    });
  });

  it('ranks past collaborators first among search results', async () => {
    mockGetLocalShareHistory.mockResolvedValue([
      { shared_with: [shareRecord(carol.id, '2026-02-01T00:00:00Z')] },
    ]);
    // Dave sorts first alphabetically ("Dave Adams"), Carol wins on history.
    mockSearchUsers.mockResolvedValue([dave, carol]);

    renderShareScreen();
    await waitFor(() => expect(screen.getByTestId('share-recent-suggestions')).toBeTruthy());

    fireEvent.changeText(screen.getByTestId('share-search-input'), 'a');

    await waitFor(() => expect(screen.getByTestId('share-search-results')).toBeTruthy());

    const rendered = screen
      .getAllByText(/^@(carol|dave)$/)
      .map((node) => [node.props.children].flat().join(''));
    expect(rendered).toEqual(['@carol', '@dave']);
  });
});
