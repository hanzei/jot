/**
 * Tests for OfflineProvider's queue-drain triggers: drain-after-enqueue,
 * foreground drain, the re-entrancy guard, and backoff + failure cap (so a
 * persistently failing server never produces a busy-loop). See issue #473.
 */

import { render, act } from '@testing-library/react-native';
import { AppState, AppStateStatus, Text } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';
import { OfflineProvider, useOfflineContext } from '../src/store/OfflineContext';
import { drainQueue, getPendingCount } from '../src/db/syncQueue';
import { getQueuedImageUploadCount } from '../src/db/imageUploadQueue';
import { setLocalModeActive } from '../src/store/localMode';
import * as serverReachability from '../src/api/serverReachability';

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

jest.mock('../src/db/imageUploadQueue', () => ({
  drainImageUploadQueue: jest.fn().mockResolvedValue({ uploadedNoteIds: [], discardedCount: 0 }),
  getQueuedImageUploadCount: jest.fn().mockResolvedValue(0),
}));

const mockRevalidate = jest.fn().mockResolvedValue(true);
jest.mock('../src/store/AuthContext', () => ({
  useAuth: () => ({ revalidateSession: mockRevalidate }),
}));

// serverSwitchLifecycle is used (transitively) by the API client too, so use the
// real module — its default state already reports isSyncDrainPaused() === false.

const mockDrainQueue = drainQueue as jest.MockedFunction<typeof drainQueue>;
const mockGetPendingCount = getPendingCount as jest.MockedFunction<typeof getPendingCount>;
const mockGetQueuedImageUploadCount = getQueuedImageUploadCount as jest.MockedFunction<typeof getQueuedImageUploadCount>;

// Captures the latest syncError value exposed through the context.
let lastSyncError = false;
// Captures the latest lastSyncedAt/consecutiveFailureCount exposed through the context.
let lastSyncedAt: string | null = null;
let lastConsecutiveFailureCount = 0;
function SyncErrorProbe() {
  const { syncError, lastSyncedAt: syncedAt, consecutiveFailureCount } = useOfflineContext();
  // eslint-disable-next-line react-hooks/globals -- test probe captures render output by design
  lastSyncError = syncError;
  // eslint-disable-next-line react-hooks/globals -- test probe captures render output by design
  lastSyncedAt = syncedAt;
  // eslint-disable-next-line react-hooks/globals -- test probe captures render output by design
  lastConsecutiveFailureCount = consecutiveFailureCount;
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
    lastSyncedAt = null;
    lastConsecutiveFailureCount = 0;
    mockRevalidate.mockResolvedValue(true);
    mockDrainQueue.mockResolvedValue({ idMappings: [], discardedOperations: [], syncedSettings: false });
    mockGetPendingCount.mockResolvedValue(0);
    mockGetQueuedImageUploadCount.mockResolvedValue(0);
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

  it('revalidates the session after a settings drain even with an unrelated image upload backlog', async () => {
    // The note/settings queue (sync_queue) is empty, but an independent image
    // upload is still queued — that backlog must not hold the settings
    // revalidation hostage; it has nothing to do with the settings write.
    mockDrainQueue.mockResolvedValue({ idMappings: [], discardedOperations: [], syncedSettings: true });
    mockGetPendingCount.mockResolvedValue(0);
    mockGetQueuedImageUploadCount.mockResolvedValue(2);
    renderProvider();
    await flush();
    mockRevalidate.mockClear();

    act(() => {
      enqueueListener?.();
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flush();

    expect(mockRevalidate).toHaveBeenCalledTimes(1);
  });

  it('does not revalidate the session after a settings drain while the note queue itself is still pending', async () => {
    mockDrainQueue.mockResolvedValue({ idMappings: [], discardedOperations: [], syncedSettings: true });
    mockGetPendingCount.mockResolvedValue(1);
    mockGetQueuedImageUploadCount.mockResolvedValue(0);
    renderProvider();
    await flush();
    mockRevalidate.mockClear();

    act(() => {
      enqueueListener?.();
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flush();

    expect(mockRevalidate).not.toHaveBeenCalled();
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

  it('skips the network drain while the server is known-unreachable (#718)', async () => {
    const reachableSpy = jest.spyOn(serverReachability, 'isServerReachable').mockReturnValue(false);

    renderProvider();
    await flush();
    // Mount drain must not fire the network — the server is known-down.
    expect(mockDrainQueue).not.toHaveBeenCalled();

    // A foreground trigger while still unreachable must not fire it either.
    const handler = getAppStateHandler();
    await act(async () => {
      handler('active');
    });
    await flush();
    expect(mockDrainQueue).not.toHaveBeenCalled();

    reachableSpy.mockRestore();
  });

  it('resumes draining once reachability is re-armed (#718)', async () => {
    const reachableSpy = jest.spyOn(serverReachability, 'isServerReachable').mockReturnValue(false);

    renderProvider();
    await flush();
    expect(mockDrainQueue).not.toHaveBeenCalled();

    // Reachability is re-armed (e.g. a successful response, SSE reopen, or a
    // device reconnect) and a fresh trigger fires — the drain resumes as today.
    reachableSpy.mockReturnValue(true);
    const handler = getAppStateHandler();
    await act(async () => {
      handler('active');
    });
    await flush();

    expect(mockDrainQueue).toHaveBeenCalledTimes(1);

    reachableSpy.mockRestore();
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

  it('records lastSyncedAt after a successful drain and tracks the consecutive-failure count', async () => {
    // Every drain leaves entries behind → stalls, bumping the failure counter.
    mockGetPendingCount.mockResolvedValue(1);
    renderProvider();
    await flush();

    expect(lastSyncedAt).toBeNull();
    expect(lastConsecutiveFailureCount).toBe(1);

    await act(async () => {
      jest.advanceTimersByTime(60000);
    });
    await flush();
    expect(lastConsecutiveFailureCount).toBe(2);

    // The queue clears on the next attempt: drain succeeds, resetting the
    // failure count and stamping lastSyncedAt.
    mockGetPendingCount.mockResolvedValue(0);
    await act(async () => {
      jest.advanceTimersByTime(60000);
    });
    await flush();

    expect(lastConsecutiveFailureCount).toBe(0);
    expect(lastSyncedAt).not.toBeNull();
  });

  it('logs each stalled drain attempt and only logs a recovery when there was a failure streak', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    // A routine successful drain (no prior failures) must not log a recovery —
    // it fires on nearly every enqueue and would drown out everything else.
    renderProvider();
    await flush();
    expect(infoSpy).not.toHaveBeenCalled();
    warnSpy.mockClear();

    // Every subsequent drain leaves entries behind, so it stalls and logs.
    mockGetPendingCount.mockResolvedValue(1);
    act(() => {
      enqueueListener?.();
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flush();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/stalled \(attempt 1\/6\)/);

    // Recovering from that failure streak logs a recovery line.
    mockGetPendingCount.mockResolvedValue(0);
    await act(async () => {
      jest.advanceTimersByTime(60000);
    });
    await flush();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toMatch(/succeeded after 1 failed attempt/);

    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });
});
