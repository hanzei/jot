import { renderHook } from '@testing-library/react-native';
import { useOfflineContext } from '../src/store/OfflineContext';
import { useSSEContext } from '../src/store/SSEContext';
import { useAuth } from '../src/store/AuthContext';
import { useVisibleTopBanners } from '../src/hooks/useTopBanners';
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
};

function setup(opts: {
  isConnected?: boolean;
  sseReconnecting?: boolean;
  syncError?: boolean;
  revalidationFailed?: boolean;
  syncFailureCount?: number;
  syncFailuresBannerDismissed?: boolean;
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
  } as unknown as ReturnType<typeof useAuth>);
}

describe('useVisibleTopBanners', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setup();
  });

  it('returns no banners when everything is healthy', () => {
    const { result } = renderHook(() => useVisibleTopBanners());
    expect(result.current).toEqual([]);
  });

  it('shows only the offline banner while offline', () => {
    // syncError/reconnect are gated on isConnected, so offline wins alone.
    setup({ isConnected: false, syncError: true, sseReconnecting: true });
    const { result } = renderHook(() => useVisibleTopBanners());
    expect(result.current).toEqual(['offline']);
  });

  it('stacks the sync-failures banner below the offline banner when both apply', () => {
    // Dead-lettered changes stay failed regardless of connectivity, so the
    // sync-failures banner is intentionally not gated on isConnected.
    setup({ isConnected: false, syncFailureCount: 2 });
    const { result } = renderHook(() => useVisibleTopBanners());
    expect(result.current).toEqual(['offline', 'syncFailures']);
  });

  it('shows the SSE reconnect banner when online but the stream is down', () => {
    setup({ sseReconnecting: true });
    const { result } = renderHook(() => useVisibleTopBanners());
    expect(result.current).toEqual(['sseReconnect']);
  });

  it('stacks banners in a fixed top-to-bottom order', () => {
    setup({
      sseReconnecting: true,
      syncError: true,
      revalidationFailed: true,
      syncFailureCount: 2,
    });
    const { result } = renderHook(() => useVisibleTopBanners());
    expect(result.current).toEqual([
      'sseReconnect',
      'syncError',
      'revalidation',
      'syncFailures',
    ]);
  });

  it('hides the sync-failures banner once dismissed', () => {
    setup({ syncFailureCount: 3, syncFailuresBannerDismissed: true });
    const { result } = renderHook(() => useVisibleTopBanners());
    expect(result.current).toEqual([]);
  });
});

describe('useBannerShown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setup();
  });

  it('is false when no banner is visible', () => {
    const { result } = renderHook(() => useBannerShown());
    expect(result.current).toBe(false);
  });

  // Regression: the SSE reconnect bar must make screens skip their own top
  // inset, otherwise the inset is applied twice and a gap appears above the bar.
  it('is true when only the SSE reconnect banner is showing', () => {
    setup({ sseReconnecting: true });
    const { result } = renderHook(() => useBannerShown());
    expect(result.current).toBe(true);
  });
});
