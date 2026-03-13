import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppState, AppStateStatus } from 'react-native';
import { useSSE } from '../src/hooks/useSSE';
import { SSEConnectionManager } from '../src/api/events';
import { SSEEvent } from '../src/types';

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
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

    act(() => {
      capturedCallback?.({
        type: 'note_created',
        note_id: 'new-note',
        note: null,
        source_user_id: 'other-user',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notes'] });
  });

  it('invalidates notes list and specific note on note_updated event', () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });

    act(() => {
      capturedCallback?.({
        type: 'note_updated',
        note_id: 'note-123',
        note: null,
        source_user_id: 'other-user',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notes'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['note', 'note-123'] });
  });

  it('invalidates notes list and removes note query on note_deleted event', () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const removeSpy = jest.spyOn(queryClient, 'removeQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });

    act(() => {
      capturedCallback?.({
        type: 'note_deleted',
        note_id: 'note-123',
        note: null,
        source_user_id: 'other-user',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notes'] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['note', 'note-123'] });
  });

  it('skips events from the current user', () => {
    const { queryClient, Wrapper } = createWrapper();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useSSE(), { wrapper: Wrapper });

    // Clear the initial invalidation call from the connect effect
    invalidateSpy.mockClear();

    act(() => {
      capturedCallback?.({
        type: 'note_created',
        note_id: 'new-note',
        note: null,
        source_user_id: 'current-user', // Same as mock user
      });
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('calls notification callback on note_updated from other user', () => {
    const { Wrapper } = createWrapper();
    const onNotify = jest.fn();

    renderHook(() => useSSE(onNotify), { wrapper: Wrapper });

    const event: SSEEvent = {
      type: 'note_updated',
      note_id: 'note-123',
      note: null,
      source_user_id: 'other-user',
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
        note_id: 'note-123',
        note: null,
        source_user_id: 'other-user',
        target_user_id: 'current-user',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notes'] });

    invalidateSpy.mockClear();

    act(() => {
      capturedCallback?.({
        type: 'note_unshared',
        note_id: 'note-123',
        note: null,
        source_user_id: 'other-user',
        target_user_id: 'current-user',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notes'] });
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
