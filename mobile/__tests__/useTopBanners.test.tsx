import { renderHook } from '@testing-library/react-native';
import { useOfflineContext } from '../src/store/OfflineContext';
import { useSSEContext } from '../src/store/SSEContext';
import { useAuth } from '../src/store/AuthContext';
import { useTopBanner } from '../src/hooks/useTopBanners';
import { useNoteFailureBarShown } from '../src/store/noteFailureBar';
import { useBannerShown } from '../src/hooks/useBannerShown';

jest.mock('../src/store/OfflineContext', () => ({
  useOfflineContext: jest.fn(),
}));
jest.mock('../src/store/SSEContext', () => ({
  useSSEContext: jest.fn(),
}));
jest.mock('../src/store/AuthContext', () => ({
  useAuth: jest.fn(),
}));
jest.mock('../src/store/noteFailureBar', () => ({
  useNoteFailureBarShown: jest.fn(() => false),
}));

const mockOffline = useOfflineContext as jest.MockedFunction<typeof useOfflineContext>;
const mockSSE = useSSEContext as jest.MockedFunction<typeof useSSEContext>;
const mockAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockNoteFailureBarShown = useNoteFailureBarShown as jest.MockedFunction<typeof useNoteFailureBarShown>;

const baseOffline = {
  isConnected: true,
  syncError: false,
  pendingNoteIds: new Set<string>(),
  failedNoteIds: new Set<string>(),
  syncFailureCount: 0,
  syncFailuresBannerDismissed: false,
  dismissSyncFailuresBanner: jest.fn(),
  refreshSyncFailures: jest.fn(),
  lastSyncedAt: null,
  consecutiveFailureCount: 0,
};

function setup(opts: {
  isConnected?: boolean;
  sseReconnecting?: boolean;
  syncError?: boolean;
  revalidationFailed?: boolean;
  syncFailureCount?: number;
  syncFailuresBannerDismissed?: boolean;
  isLocalMode?: boolean;
  noteFailureBarShown?: boolean;
} = {}) {
  mockOffline.mockReturnValue({
    ...baseOffline,
    isConnected: opts.isConnected ?? true,
    syncError: opts.syncError ?? false,
    syncFailureCount: opts.syncFailureCount ?? 0,
    syncFailuresBannerDismissed: opts.syncFailuresBannerDismissed ?? false,
  });
  mockSSE.mockReturnValue({
    subscribe: jest.fn(() => jest.fn()),
    sseReconnecting: opts.sseReconnecting ?? false,
  });
  mockAuth.mockReturnValue({
    revalidationFailed: opts.revalidationFailed ?? false,
    isLocalMode: opts.isLocalMode ?? false,
  } as unknown as ReturnType<typeof useAuth>);
  mockNoteFailureBarShown.mockReturnValue(opts.noteFailureBarShown ?? false);
}

describe('useTopBanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setup();
  });

  const shown = async () => (await renderHook(() => useTopBanner())).result.current;

  it('shows no banner when everything is healthy', async () => {
    expect(await shown()).toBeNull();
  });

  it('shows only the offline banner while offline, whatever else is true', async () => {
    setup({ isConnected: false, syncError: true, sseReconnecting: true, revalidationFailed: true, syncFailureCount: 2 });
    expect(await shown()).toBe('offline');
  });

  // The device screenshot behind this: "Connecting to server…", the sync-error
  // strip, and "5 changes couldn't be saved" stacked, all from one outage.
  it('shows only the reconnect banner while the server is unreachable', async () => {
    setup({ sseReconnecting: true, syncError: true, revalidationFailed: true, syncFailureCount: 5 });
    expect(await shown()).toBe('sseReconnect');
  });

  it('shows no reconnect banner in local mode', async () => {
    setup({ sseReconnecting: true, isLocalMode: true });
    expect(await shown()).toBeNull();
  });

  it('prefers the sync-error banner over failed changes and revalidation', async () => {
    setup({ syncError: true, revalidationFailed: true, syncFailureCount: 2 });
    expect(await shown()).toBe('syncError');
  });

  it('shows failed changes once the connection states are clear', async () => {
    setup({ revalidationFailed: true, syncFailureCount: 2 });
    expect(await shown()).toBe('syncFailures');
  });

  it('falls through to the next banner once failed changes are dismissed', async () => {
    setup({ syncFailureCount: 3, syncFailuresBannerDismissed: true, revalidationFailed: true });
    expect(await shown()).toBe('revalidation');
  });

  it('hides failed changes while a focused note shows its own failed-change bar', async () => {
    setup({ syncFailureCount: 3, noteFailureBarShown: true });
    expect(await shown()).toBeNull();
  });
});

describe('useBannerShown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setup();
  });

  it('is false when no banner is visible', async () => {
    const { result } = await renderHook(() => useBannerShown());
    expect(result.current).toBe(false);
  });

  // Regression: the SSE reconnect bar must make screens skip their own top
  // inset, otherwise the inset is applied twice and a gap appears above the bar.
  it('is true when only the SSE reconnect banner is showing', async () => {
    setup({ sseReconnecting: true });
    const { result } = await renderHook(() => useBannerShown());
    expect(result.current).toBe(true);
  });
});
