/**
 * Tests for ShareScreen's user-search connectivity handling (issue #717):
 * the online-but-server-down path must fall back to the local user filter
 * immediately instead of eating the full request timeout and surfacing a
 * hard error.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ShareScreen from '../src/screens/ShareScreen';
import { searchUsers } from '../src/api/users';
import { useNoteShares, useShareNote, useUnshareNote } from '../src/hooks/useNotes';
import { useNetworkStatus } from '../src/hooks/useNetworkStatus';
import { useUsers } from '../src/store/UsersContext';
import { isServerReachable } from '../src/api/serverReachability';
import type { User } from '@jot/shared';

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

jest.mock('../src/api/serverReachability', () => ({
  isServerReachable: jest.fn(),
}));

const mockSearchUsers = searchUsers as jest.MockedFunction<typeof searchUsers>;
const mockUseNoteShares = useNoteShares as jest.MockedFunction<typeof useNoteShares>;
const mockUseShareNote = useShareNote as jest.MockedFunction<typeof useShareNote>;
const mockUseUnshareNote = useUnshareNote as jest.MockedFunction<typeof useUnshareNote>;
const mockUseNetworkStatus = useNetworkStatus as jest.MockedFunction<typeof useNetworkStatus>;
const mockUseUsers = useUsers as jest.MockedFunction<typeof useUsers>;
const mockIsServerReachable = isServerReachable as jest.MockedFunction<typeof isServerReachable>;

const localUser: User = {
  id: 'user-local',
  username: 'localmatch',
  first_name: 'Local',
  last_name: 'Match',
  role: 'user',
  has_profile_icon: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

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
