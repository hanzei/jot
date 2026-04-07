import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppState, AppStateStatus } from 'react-native';
import { useSSE } from '../src/hooks/useSSE';
import { SSEConnectionManager } from '../src/api/events';
import type { SSEEvent } from '@jot/shared';
import { noteQueryKey, notesQueryScopeKey } from '../src/hooks/queryKeys';

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

jest.mock('expo-sqlite', () => ({
  useSQLiteContext: jest.fn(() => ({
    runAsync: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Fixed CLIENT_ID for tests — matches what useSSE imports from api/client.
const TEST_CLIENT_ID = 'test-device-client-id';
jest.mock('../src/api/client', () => ({
  ...jest.requireActual('../src/api/client'),
  CLIENT_ID: TEST_CLIENT_ID,
}));

// Mock SSEConnectionManager
let capturedCallback: ((event: SSEEvent) => void) | null = null;
const mockConnect = jest.fn().mockImplementation(async (cb: (event: SSEEvent) => void) => {
  capturedCallback = cb;
});
const mockDisconnect = jest.fn();

jest.mock('../src/api/events', () => ({
  SSEConnectionManager: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
  })),
}));

// Mock useAuth
const mockUser = { id: 'current-user', username: 'testuser' };
let mockIsAuthenticated = true;
jest.mock('../src/store/AuthContext', () => ({
  useAuth: () => ({
    user: mockIsAuthenticated ? mockUser : null,
    isAuthenticated: mockIsAuthenticated,
  }),
}));

// Mock useNetworkStatus — default connected
let mockIsConnected = true;
jest.mock('../src/hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => ({ isConnected: mockIsConnected }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return { queryClient, Wrapper: ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  ) };
}

describe('useSSE', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    capturedCallback = null;
    mockIsAuthenticated = true;
    mockIsConnected = true;
  });

  it('starts SSE connection when authenticated', () => {
    const { Wrapper } = createWrapper();
    renderHook(() => useSSE(), { wrapper: Wrapper });

    expect(SSEConnectionManager).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
  });

  it('does not start connection when not authenticated', () => {
    mockIsAuthenticated = false;
    const { Wrapper } = createWrapper();
    renderHook(() => useSSE(), { wrapper: Wrapper });

    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('disconnects on unmount', () => {
    const { Wrapper } = createWrapper();
    const { unmount } = renderHook(() => useSSE(), { wrapper: Wrapper });

    unmount();

    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('invalidates notes list on note_created event', () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    act(() => {
      capturedCallback?.({
        type: 'note_created',
        source_user_id: 'other-user',
        data: { note_id: 'new-note', note: null },
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesQueryScopeKey() });
  });

  it('invalidates notes list and specific note on note_updated event', () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    act(() => {
      capturedCallback?.({
        type: 'note_updated',
        source_user_id: 'other-user',
        data: { note_id: 'note-123', note: null },
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesQueryScopeKey() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: noteQueryKey('note-123') });
  });

  it('invalidates notes list and removes note query on note_deleted event', () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const removeSpy = jest.spyOn(queryClient, 'removeQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    act(() => {
      capturedCallback?.({
        type: 'note_deleted',
        source_user_id: 'other-user',
        data: { note_id: 'note-123', note: null },
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesQueryScopeKey() });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: noteQueryKey('note-123') });
  });

  it('invalidates queries for same-user events from a different device', () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });

    // Clear the initial invalidation call from the connect effect
    invalidateSpy.mockClear();

    act(() => {
      capturedCallback?.({
        type: 'note_updated',
        source_user_id: 'current-user', // Same user, different device
        client_id: 'other-device-client-id', // Different device — must not be filtered
        data: { note_id: 'note-123', note: null },
      });
    });

    // Queries must be invalidated so the current device syncs the remote change
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesQueryScopeKey() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: noteQueryKey('note-123') });
  });

  it('filters out events from the same device (matching client_id)', () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const onNotify = jest.fn();

    renderHook(() => useSSE(onNotify), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    act(() => {
      capturedCallback?.({
        type: 'note_updated',
        source_user_id: 'current-user',
        client_id: TEST_CLIENT_ID, // Same device — must be filtered
        data: { note_id: 'note-123', note: null },
      });
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(onNotify).not.toHaveBeenCalled();
  });

  it('does not call notification callback for same-user events', () => {
    const { Wrapper } = createWrapper();
    const onNotify = jest.fn();

    renderHook(() => useSSE(onNotify), { wrapper: Wrapper });

    act(() => {
      capturedCallback?.({
        type: 'note_updated',
        source_user_id: 'current-user', // Same user — should not show "updated by another user" toast
        data: { note_id: 'note-123', note: null },
      });
    });

    expect(onNotify).not.toHaveBeenCalled();
  });

  it('calls notification callback on note_updated from another user', () => {
    const { Wrapper } = createWrapper();
    const onNotify = jest.fn();

    renderHook(() => useSSE(onNotify), { wrapper: Wrapper });

    const event: SSEEvent = {
      type: 'note_updated',
      source_user_id: 'other-user',
      data: { note_id: 'note-123', note: null },
    };

    act(() => {
      capturedCallback?.(event);
    });

    expect(onNotify).toHaveBeenCalledWith(event);
  });

  it('invalidates notes list on note_shared and note_unshared events', () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });
    invalidateSpy.mockClear();

    act(() => {
      capturedCallback?.({
        type: 'note_shared',
        source_user_id: 'other-user',
        target_user_id: 'current-user',
        data: { note_id: 'note-123', note: null },
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesQueryScopeKey() });

    invalidateSpy.mockClear();

    act(() => {
      capturedCallback?.({
        type: 'note_unshared',
        source_user_id: 'other-user',
        target_user_id: 'current-user',
        data: { note_id: 'note-123', note: null },
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: notesQueryScopeKey() });
  });

  it('does not start connection when offline', () => {
    mockIsConnected = false;
    const { Wrapper } = createWrapper();
    renderHook(() => useSSE(), { wrapper: Wrapper });

    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('stops connection when going offline and reconnects when coming back online', () => {
    const { Wrapper } = createWrapper();

    // Start online
    mockIsConnected = true;
    const { rerender } = renderHook(() => useSSE(), { wrapper: Wrapper });
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Go offline — re-render with updated mock value
    mockIsConnected = false;
    mockDisconnect.mockClear();
    rerender({});
    expect(mockDisconnect).toHaveBeenCalled();

    // Come back online — should reconnect
    mockIsConnected = true;
    mockConnect.mockClear();
    rerender({});
    expect(mockConnect).toHaveBeenCalled();
  });

  it('registers AppState listener for foreground/background management', () => {
    const { Wrapper } = createWrapper();
    renderHook(() => useSSE(), { wrapper: Wrapper });

    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('disconnects on background and reconnects on foreground', () => {
    const { Wrapper } = createWrapper();
    renderHook(() => useSSE(), { wrapper: Wrapper });

    // Get the AppState change handler
    const appStateHandler = (AppState.addEventListener as jest.Mock).mock.calls[0][1] as (
      state: AppStateStatus,
    ) => void;

    // Going to background should disconnect
    act(() => {
      appStateHandler('background');
    });
    expect(mockDisconnect).toHaveBeenCalled();

    // Returning to foreground should reconnect
    mockConnect.mockClear();
    act(() => {
      appStateHandler('active');
    });
    expect(mockConnect).toHaveBeenCalled();
  });
});
