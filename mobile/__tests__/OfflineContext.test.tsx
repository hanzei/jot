/**
 * Tests for OfflineProvider's queue-drain triggers: drain-after-enqueue,
 * foreground drain, the re-entrancy guard, and backoff + failure cap (so a
 * persistently failing server never produces a busy-loop). See issue #473.
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';
import { AppState, AppStateStatus, Text } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';
import { OfflineProvider, useOfflineContext } from '../src/store/OfflineContext';
import { drainQueue, getPendingCount } from '../src/db/syncQueue';
import { setLocalModeActive } from '../src/store/localMode';

// Capture the enqueue listener registered by the provider so tests can fire it.
let enqueueListener: (() => void) | null = null;

jest.mock('../src/db/syncQueue', () => ({
  drainQueue: jest.fn().mockResolvedValue({ idMappings: [], discardedOperations: [], syncedSettings: false }),
  getPendingCount: jest.fn().mockResolvedValue(0),
  getDeadLetterCount: jest.fn().mockResolvedValue(0),
  subscribeToEnqueue: jest.fn((listener: () => void) => {
    enqueueListener = listener;
    return () => {
      enqueueListener = null;
    };
  }),
}));

const mockRevalidate = jest.fn().mockResolvedValue(true);
jest.mock('../src/store/AuthContext', () => ({
  useAuth: () => ({ revalidateSession: mockRevalidate }),
}));

// serverSwitchLifecycle is used (transitively) by the API client too, so use the
// real module — its default state already reports isSyncDrainPaused() === false.

const mockDrainQueue = drainQueue as jest.MockedFunction<typeof drainQueue>;
const mockGetPendingCount = getPendingCount as jest.MockedFunction<typeof getPendingCount>;

// Captures the latest syncError value exposed through the context.
let lastSyncError = false;
function SyncErrorProbe() {
  const { syncError } = useOfflineContext();
  lastSyncError = syncError;
  return <Text>{String(syncError)}</Text>;
}

function renderProvider() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OfflineProvider>
        <SyncErrorProbe />
      </OfflineProvider>
    </QueryClientProvider>,
  );
}

// Flush pending microtasks (promise continuations) within act().
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function getAppStateHandler(): (state: AppStateStatus) => void {
  const spy = AppState.addEventListener as jest.Mock;
  const call = spy.mock.calls.find((c) => c[0] === 'change');
  if (!call) throw new Error('AppState change handler not registered');
  return call[1] as (state: AppStateStatus) => void;
}

describe('OfflineProvider queue draining', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    enqueueListener = null;
    lastSyncError = false;
    mockRevalidate.mockResolvedValue(true);
    mockDrainQueue.mockResolvedValue({ idMappings: [], discardedOperations: [], syncedSettings: false });
    mockGetPendingCount.mockResolvedValue(0);
    jest.spyOn(AppState, 'addEventListener');
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    setLocalModeActive(false);
  });

  it('never drains the queue in local mode (mount, foreground, or enqueue)', async () => {
    setLocalModeActive(true);
    renderProvider();
    await flush();
    // Mount must not drain.
    expect(mockDrainQueue).not.toHaveBeenCalled();

    // A foreground transition must not drain either.
    const handler = getAppStateHandler();
    await act(async () => {
      handler('active');
    });
    await flush();

    // Nor an enqueue signal after its debounce window elapses.
    act(() => {
      enqueueListener?.();
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flush();

    expect(mockDrainQueue).not.toHaveBeenCalled();
  });

  it('drains once on mount when starting online', async () => {
    renderProvider();
    await flush();
    expect(mockDrainQueue).toHaveBeenCalledTimes(1);
  });

  it('drains shortly after a write is enqueued while online (debounced)', async () => {
    renderProvider();
    await flush();
    mockDrainQueue.mockClear();

    act(() => {
      enqueueListener?.();
    });
    // The debounce window has not elapsed yet, so no drain has run.
    expect(mockDrainQueue).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flush();

    expect(mockDrainQueue).toHaveBeenCalledTimes(1);
  });

  it('drains when the app returns to the foreground', async () => {
    renderProvider();
    await flush();
    mockDrainQueue.mockClear();

    const handler = getAppStateHandler();
    await act(async () => {
      handler('active');
    });
    await flush();

    expect(mockDrainQueue).toHaveBeenCalledTimes(1);
  });

  it('never runs two drains concurrently and reruns once for ops enqueued mid-drain', async () => {
    // Hold the first drain open so a second trigger arrives while it is in flight.
    let resolveFirst: (() => void) | undefined;
    mockDrainQueue.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = () => resolve({ idMappings: [], discardedOperations: [], syncedSettings: false });
        }),
    );

    renderProvider();
    await flush();
    // The mount drain is now in flight (pending on resolveFirst).
    expect(mockDrainQueue).toHaveBeenCalledTimes(1);

    // Fire an enqueue while the drain is running — it must not start a 2nd drain.
    act(() => {
      enqueueListener?.();
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(mockDrainQueue).toHaveBeenCalledTimes(1);

    // Resolve the in-flight drain; the queued rerun should now fire exactly one more.
    await act(async () => {
      resolveFirst?.();
    });
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    await flush();

    expect(mockDrainQueue).toHaveBeenCalledTimes(2);
  });

  it('applies backoff and stops after the failure cap instead of busy-looping', async () => {
    // Every drain leaves entries behind → each attempt counts as a stalled drain.
    mockGetPendingCount.mockResolvedValue(1);

    renderProvider();
    await flush();

    // Drive the backoff retries well past the cap; advancing the max backoff each
    // round fires at most one scheduled retry per round.
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        jest.advanceTimersByTime(60000);
      });
      await flush();
    }

    // Retries are capped (mount drain + bounded retries), never unbounded.
    expect(mockDrainQueue.mock.calls.length).toBe(6);
    expect(lastSyncError).toBe(true);
  });

  it('clears the sync error and resumes draining on reconnect after the cap is hit', async () => {
    mockGetPendingCount.mockResolvedValue(1);
    renderProvider();
    await flush();
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        jest.advanceTimersByTime(60000);
      });
      await flush();
    }
    expect(lastSyncError).toBe(true);
    expect(mockDrainQueue).toHaveBeenCalledTimes(6);

    // Connectivity recovers: the next drain succeeds and clears the error.
    mockGetPendingCount.mockResolvedValue(0);
    const handler = getAppStateHandler();
    await act(async () => {
      handler('active');
    });
    await flush();

    expect(mockDrainQueue).toHaveBeenCalledTimes(7);
    expect(lastSyncError).toBe(false);
  });

  it('cancels the scheduled retry and stops draining when connectivity drops to offline', async () => {
    // Every drain stalls, so the mount drain schedules a backoff retry.
    mockGetPendingCount.mockResolvedValue(1);
    renderProvider();
    await flush();
    expect(mockDrainQueue).toHaveBeenCalledTimes(1);

    // NetInfo reports the device went offline.
    const netInfoListener = (NetInfo.addEventListener as jest.Mock).mock.calls[0][0] as (
      state: { isConnected: boolean; isInternetReachable: boolean },
    ) => void;
    await act(async () => {
      netInfoListener({ isConnected: false, isInternetReachable: false });
    });

    // The pending backoff retry must not fire while offline.
    await act(async () => {
      jest.advanceTimersByTime(60000);
    });
    await flush();
    expect(mockDrainQueue).toHaveBeenCalledTimes(1);
  });

  it('resets the retry budget and resumes draining when a new write is enqueued after the cap', async () => {
    mockGetPendingCount.mockResolvedValue(1);
    renderProvider();
    await flush();
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        jest.advanceTimersByTime(60000);
      });
      await flush();
    }
    expect(lastSyncError).toBe(true);
    expect(mockDrainQueue).toHaveBeenCalledTimes(6);

    // The server recovers and the user makes another edit while still online.
    mockGetPendingCount.mockResolvedValue(0);
    act(() => {
      enqueueListener?.();
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flush();

    expect(mockDrainQueue).toHaveBeenCalledTimes(7);
    expect(lastSyncError).toBe(false);
  });
});
