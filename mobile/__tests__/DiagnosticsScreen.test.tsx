/**
 * Tests for the Diagnostics screen's server-reachability and sync-freshness
 * surfacing (issue #700): server reachable distinct from device connectivity,
 * last-successful-sync time, drain outcome / consecutive-failure count, and
 * dead-letter count — all mirrored into the "Share diagnostics" report.
 */

import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';
import DiagnosticsScreen from '../src/screens/DiagnosticsScreen';
import { useOfflineContext } from '../src/store/OfflineContext';
import {
  isServerReachable,
  getServerReachabilityChangedAt,
  subscribeToServerReachability,
} from '../src/api/serverReachability';
import { getSseState, subscribeToSseState } from '../src/api/sseState';
import { getAboutInfo } from '../src/api/settings';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('../src/api/client', () => ({
  getBaseUrl: jest.fn(() => 'https://example.com'),
  subscribeToClientActiveServerChanges: jest.fn(() => () => {}),
}));

const baseOfflineContext = {
  isConnected: true,
  syncError: false,
  pendingNoteIds: new Set<string>(),
  failedNoteIds: new Set<string>(),
  syncFailureCount: 0,
  syncFailuresBannerDismissed: false,
  dismissSyncFailuresBanner: jest.fn(),
  refreshSyncFailures: jest.fn(),
  lastSyncedAt: null as string | null,
  consecutiveFailureCount: 0,
};

jest.mock('../src/store/OfflineContext', () => ({
  useOfflineContext: jest.fn(),
}));

jest.mock('../src/api/serverReachability', () => ({
  isServerReachable: jest.fn(() => true),
  getServerReachabilityChangedAt: jest.fn(() => null),
  subscribeToServerReachability: jest.fn(() => () => {}),
}));

jest.mock('../src/api/sseState', () => ({
  getSseState: jest.fn(() => ({ isConnected: true, reconnectAttempts: 0 })),
  subscribeToSseState: jest.fn(() => () => {}),
}));

jest.mock('../src/api/settings', () => ({
  getAboutInfo: jest.fn(),
}));

jest.mock('../src/utils/appInfo', () => ({
  getAppBuildInfo: jest.fn(() => ({
    version: '1.2.3',
    commit: 'abc1234',
    buildTime: '2026-10-01T12:00:00Z',
  })),
}));

const mockGetAboutInfo = getAboutInfo as jest.MockedFunction<typeof getAboutInfo>;
const mockUseOfflineContext = useOfflineContext as jest.MockedFunction<typeof useOfflineContext>;
const mockIsServerReachable = isServerReachable as jest.MockedFunction<typeof isServerReachable>;
const mockGetServerReachabilityChangedAt =
  getServerReachabilityChangedAt as jest.MockedFunction<typeof getServerReachabilityChangedAt>;
const mockSubscribeToServerReachability =
  subscribeToServerReachability as jest.MockedFunction<typeof subscribeToServerReachability>;
const mockGetSseState = getSseState as jest.MockedFunction<typeof getSseState>;
const mockSubscribeToSseState = subscribeToSseState as jest.MockedFunction<typeof subscribeToSseState>;

describe('DiagnosticsScreen', () => {
  // Captures the listener DiagnosticsScreen registers, so tests can simulate a
  // reachability transition arriving while the screen is mounted.
  let reachabilityListener: ((reachable: boolean) => void) | undefined;
  let sseListener: (() => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    reachabilityListener = undefined;
    mockUseOfflineContext.mockReturnValue(baseOfflineContext);
    mockIsServerReachable.mockReturnValue(true);
    mockGetServerReachabilityChangedAt.mockReturnValue(null);
    mockGetSseState.mockReturnValue({ isConnected: true, reconnectAttempts: 0 });
    sseListener = undefined;
    mockSubscribeToSseState.mockImplementation((listener) => {
      sseListener = listener;
      return () => {
        sseListener = undefined;
      };
    });
    mockSubscribeToServerReachability.mockImplementation((listener) => {
      reachabilityListener = listener;
      return () => {
        reachabilityListener = undefined;
      };
    });
    jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    mockGetAboutInfo.mockResolvedValue({
      version: '0.9.0',
      commit: 'def5678',
      build_time: '2026-09-30T08:00:00Z',
      go_version: 'go1.25.0',
    });
  });

  it('shows server reachability distinctly from device connectivity', async () => {
    mockUseOfflineContext.mockReturnValue({ ...baseOfflineContext, isConnected: true });
    mockIsServerReachable.mockReturnValue(false);
    mockGetServerReachabilityChangedAt.mockReturnValue('2026-07-12T10:00:00.000Z');

    const { findAllByText, getAllByText } = await renderScreen();

    // Device network row still says "Connected"...
    expect((await findAllByText('Connected')).length).toBeGreaterThan(0);
    // ...while the server-reachability row says "Disconnected", proving the
    // two states are shown independently.
    expect(getAllByText('Disconnected').length).toBeGreaterThan(0);
  });

  it('labels a disconnected event stream "Connecting" until a connect attempt has failed', async () => {
    mockGetSseState.mockReturnValue({ isConnected: false, reconnectAttempts: 0 });
    const { findByText, queryByText } = await renderScreen();
    expect(await findByText('Connecting')).toBeTruthy();
    expect(queryByText('Reconnecting')).toBeNull();
  });

  it('labels a disconnected event stream "Reconnecting" once a connect attempt has failed', async () => {
    mockGetSseState.mockReturnValue({ isConnected: false, reconnectAttempts: 2 });
    const { findByText, queryByText } = await renderScreen();
    expect(await findByText('Reconnecting')).toBeTruthy();
    expect(queryByText('Connecting')).toBeNull();
  });

  it('updates the event-stream row live when its status changes, without a manual refresh', async () => {
    mockGetSseState.mockReturnValue({ isConnected: false, reconnectAttempts: 0 });
    const { findByText } = await renderScreen();
    expect(await findByText('Connecting')).toBeTruthy();

    mockGetSseState.mockReturnValue({ isConnected: false, reconnectAttempts: 1 });
    await act(async () => {
      sseListener?.();
    });

    expect(await findByText('Reconnecting')).toBeTruthy();
  });

  it('shows last-successful-sync time, drain status, consecutive failures, and dead-letter count', async () => {
    mockUseOfflineContext.mockReturnValue({
      ...baseOfflineContext,
      lastSyncedAt: '2026-07-12T09:30:00.000Z',
      syncError: true,
      consecutiveFailureCount: 4,
      syncFailureCount: 3,
    });

    const { findByText } = await renderScreen();

    expect(await findByText('Failed')).toBeTruthy();
    expect(await findByText('4')).toBeTruthy();
    expect(await findByText('3')).toBeTruthy();
  });

  it('shows "Never" for last-successful-sync when no drain has succeeded yet', async () => {
    const { findAllByText } = await renderScreen();
    expect((await findAllByText('Never')).length).toBeGreaterThan(0);
  });

  it('updates the reachability row live when a transition arrives, without a manual refresh', async () => {
    const { findByText, getAllByText, queryAllByText } = await renderScreen();
    expect(getAllByText('Connected').length).toBeGreaterThan(0);
    expect(queryAllByText('Disconnected').length).toBe(0);

    mockGetServerReachabilityChangedAt.mockReturnValue('2026-07-12T10:00:00.000Z');
    await act(async () => {
      reachabilityListener?.(false);
    });

    expect(await findByText('Disconnected')).toBeTruthy();
    expect(await findByText(new Date('2026-07-12T10:00:00.000Z').toLocaleString())).toBeTruthy();
  });

  it('includes server reachability, sync freshness, and dead-letter fields in the share report', async () => {
    mockIsServerReachable.mockReturnValue(false);
    mockGetServerReachabilityChangedAt.mockReturnValue('2026-07-12T10:00:00.000Z');
    mockUseOfflineContext.mockReturnValue({
      ...baseOfflineContext,
      lastSyncedAt: '2026-07-12T09:30:00.000Z',
      syncError: true,
      consecutiveFailureCount: 2,
      syncFailureCount: 5,
    });

    const { findByText } = await renderScreen();
    await act(async () => {
      await fireEvent.press(await findByText('Share Diagnostics Report'));
      await Promise.resolve();
    });

    expect(Share.share).toHaveBeenCalledTimes(1);
    const [{ message }] = (Share.share as jest.Mock).mock.calls[0];
    const report = JSON.parse(message);

    expect(report.network).toEqual(
      expect.objectContaining({
        isServerReachable: false,
        serverReachabilityChangedAt: '2026-07-12T10:00:00.000Z',
      }),
    );
    expect(report.sync).toEqual(
      expect.objectContaining({
        lastSyncedAt: '2026-07-12T09:30:00.000Z',
        syncError: true,
        consecutiveFailureCount: 2,
        deadLetterCount: 5,
      }),
    );
  });

  it('includes app and server build info in the share report', async () => {
    const { findByText } = await renderScreen();
    const report = await shareReport(findByText);

    expect(mockGetAboutInfo).toHaveBeenCalledTimes(1);
    expect(report.app).toEqual({
      version: '1.2.3',
      commit: 'abc1234',
      buildTime: '2026-10-01T12:00:00Z',
    });
    expect(report.server).toEqual(
      expect.objectContaining({
        url: 'https://example.com',
        version: '0.9.0',
        commit: 'def5678',
        build_time: '2026-09-30T08:00:00Z',
        go_version: 'go1.25.0',
      }),
    );
  });

  it('still shares the report with null server build fields when the about fetch fails', async () => {
    mockGetAboutInfo.mockRejectedValue(new Error('timeout of 15000ms exceeded'));
    const { findByText } = await renderScreen();
    const report = await shareReport(findByText);

    expect(mockGetAboutInfo).toHaveBeenCalledTimes(1);
    expect(report.app.version).toBe('1.2.3');
    expect(report.server).toEqual(
      expect.objectContaining({
        url: 'https://example.com',
        version: null,
        commit: null,
        build_time: null,
        go_version: null,
      }),
    );
  });

  it('skips the about fetch when the server is known unreachable', async () => {
    mockIsServerReachable.mockReturnValue(false);
    const { findByText } = await renderScreen();
    const report = await shareReport(findByText);

    expect(mockGetAboutInfo).not.toHaveBeenCalled();
    expect(report.server).toEqual(
      expect.objectContaining({ version: null, commit: null, build_time: null, go_version: null }),
    );
  });
});

async function shareReport(findByText: (text: string) => Promise<unknown>) {
  await act(async () => {
    await fireEvent.press((await findByText('Share Diagnostics Report')) as never);
  });
  await waitFor(() => expect(Share.share).toHaveBeenCalledTimes(1));
  const [{ message }] = (Share.share as jest.Mock).mock.calls[0];
  return JSON.parse(message);
}

async function renderScreen() {
  const utils = await render(<DiagnosticsScreen />);
  // Let the initial refresh() effect (an async DB read) settle.
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}
