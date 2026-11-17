import { renderHook } from '@testing-library/react-native';
import { useOfflineContext } from '../src/store/OfflineContext';
import { useSSEContext } from '../src/store/SSEContext';
import { useAuth } from '../src/store/AuthContext';
import { useTopBanners } from '../src/hooks/useTopBanners';
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

const mockOffline = useOfflineContext as jest.MockedFunction<typeof useOfflineContext>;
const mockSSE = useSSEContext as jest.MockedFunction<typeof useSSEContext>;
const mockAuth = useAuth as jest.MockedFunction<typeof useAuth>;

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
}

describe('useTopBanners', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setup();
  });

  const banners = async () => (await renderHook(() => useTopBanners())).result.current;

  it('shows nothing when everything is healthy', async () => {
    expect(await banners()).toEqual({ status: null, shown: [] });
  });

  it('reports only the offline status while offline, whatever else is true', async () => {
    setup({ isConnected: false, syncError: true, sseReconnecting: true, revalidationFailed: true });
    expect((await banners()).status).toBe('offline');
  });

  // A server that rejects the session (e.g. 403) also breaks the event stream
  // and the sync; the session is the cause, so it must not hide behind
  // "Connecting to server…".
  it('ranks a rejected session above the connection states', async () => {
    setup({ revalidationFailed: true, sseReconnecting: true, syncError: true });
    expect((await banners()).status).toBe('revalidation');
  });

  it('reports the server as unreachable over a stalled sync', async () => {
    setup({ sseReconnecting: true, syncError: true });
    expect((await banners()).status).toBe('sseReconnect');
  });

  it('reports no reconnect status in local mode', async () => {
    setup({ sseReconnecting: true, isLocalMode: true });
    expect((await banners()).status).toBeNull();
  });

  it('reports a stalled sync', async () => {
    setup({ syncError: true });
    expect((await banners()).status).toBe('syncError');
  });

  // Dead-lettered changes stay failed whatever the connection does, and this
  // banner is the way into the review screen, so a status never hides it.
  it.each([
    ['offline', { isConnected: false }, 'offline'],
    ['the server is unreachable', { sseReconnecting: true }, 'sseReconnect'],
    ['the session was rejected', { revalidationFailed: true }, 'revalidation'],
  ] as const)('shows failed changes below the status while %s', async (_label, state, status) => {
    setup({ ...state, syncFailureCount: 2 });
    expect(await banners()).toEqual({ status, shown: ['status', 'syncFailures'] });
  });

  it('puts failed changes on top when there is no status', async () => {
    setup({ syncFailureCount: 1 });
    expect(await banners()).toEqual({ status: null, shown: ['syncFailures'] });
  });

  it('hides failed changes once dismissed', async () => {
    setup({ syncFailureCount: 3, syncFailuresBannerDismissed: true });
    expect((await banners()).shown).toEqual([]);
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

  it('is true when only the failed-changes banner is showing', async () => {
    setup({ syncFailureCount: 1 });
    const { result } = await renderHook(() => useBannerShown());
    expect(result.current).toBe(true);
  });
});
