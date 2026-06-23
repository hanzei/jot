import { SSEConnectionManager } from '../src/api/events';

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

// Mock the client module to provide getStoredSession and getBaseUrl
jest.mock('../src/api/client', () => ({
  getStoredSession: jest.fn(),
  getBaseUrl: jest.fn().mockReturnValue('http://localhost:8080'),
  isServerSwitchInProgress: jest.fn(() => false),
}));
jest.mock('../src/store/serverSwitchLifecycle', () => ({
  getCurrentSwitchGenerationId: jest.fn(() => 1),
  isSseQuiesced: jest.fn(() => false),
}));

import { getStoredSession } from '../src/api/client';
const mockGetStoredSession = getStoredSession as jest.MockedFunction<typeof getStoredSession>;

// Mock react-native-sse
const mockAddEventListener = jest.fn();
const mockRemoveAllEventListeners = jest.fn();
const mockClose = jest.fn();

jest.mock('react-native-sse', () => {
  return jest.fn().mockImplementation(() => ({
    addEventListener: mockAddEventListener,
    removeAllEventListeners: mockRemoveAllEventListeners,
    close: mockClose,
  }));
});

const MockEventSource = jest.requireMock('react-native-sse') as jest.Mock;

describe('SSEConnectionManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStoredSession.mockResolvedValue('test-token');
  });

  it('connects with session cookie when token is available', async () => {
    const manager = new SSEConnectionManager();
    const callback = jest.fn();

    await manager.connect(callback);

    expect(MockEventSource).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/events'),
      expect.objectContaining({
        headers: { Cookie: 'jot_session=test-token' },
      }),
    );
    expect(mockAddEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockAddEventListener).toHaveBeenCalledWith('error', expect.any(Function));

    manager.disconnect();
  });

  it('does not connect when no token is stored', async () => {
    mockGetStoredSession.mockResolvedValue(null);

    const manager = new SSEConnectionManager();
    await manager.connect(jest.fn());

    expect(MockEventSource).not.toHaveBeenCalled();

    manager.disconnect();
  });

  it('parses and forwards SSE events to callback', async () => {
    const manager = new SSEConnectionManager();
    const callback = jest.fn();

    await manager.connect(callback);

    const messageHandler = mockAddEventListener.mock.calls.find(
      (call: [string, unknown]) => call[0] === 'message',
    )?.[1] as (event: { data?: string }) => void;

    const event = {
      type: 'note_updated',
      note_id: 'note-123',
      note: null,
      source_user_id: 'user-456',
    };

    messageHandler({ data: JSON.stringify(event) });

    expect(callback).toHaveBeenCalledWith(event);

    manager.disconnect();
  });

  it('ignores messages without data', async () => {
    const manager = new SSEConnectionManager();
    const callback = jest.fn();

    await manager.connect(callback);

    const messageHandler = mockAddEventListener.mock.calls.find(
      (call: [string, unknown]) => call[0] === 'message',
    )?.[1] as (event: { data?: string }) => void;

    messageHandler({ data: undefined });
    messageHandler({});

    expect(callback).not.toHaveBeenCalled();

    manager.disconnect();
  });

  it('ignores unparseable messages', async () => {
    const manager = new SSEConnectionManager();
    const callback = jest.fn();

    await manager.connect(callback);

    const messageHandler = mockAddEventListener.mock.calls.find(
      (call: [string, unknown]) => call[0] === 'message',
    )?.[1] as (event: { data?: string }) => void;

    messageHandler({ data: 'not-json' });

    expect(callback).not.toHaveBeenCalled();

    manager.disconnect();
  });

  it('cleans up on disconnect', async () => {
    const manager = new SSEConnectionManager();
    await manager.connect(jest.fn());

    manager.disconnect();

    expect(mockRemoveAllEventListeners).toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalled();
  });

  it('schedules reconnect with exponential backoff on non-401 errors', async () => {
    jest.useFakeTimers();

    const manager = new SSEConnectionManager();
    await manager.connect(jest.fn());

    const errorHandler = mockAddEventListener.mock.calls.find(
      (call: [string, unknown]) => call[0] === 'error',
    )?.[1] as (event: { status?: number }) => void;

    // Clear to track the reconnect
    MockEventSource.mockClear();

    // Trigger a non-401 error
    errorHandler({});

    // Should not reconnect immediately
    expect(MockEventSource).not.toHaveBeenCalled();

    // First reconnect after base delay (3s)
    await jest.advanceTimersByTimeAsync(3000);
    expect(MockEventSource).toHaveBeenCalledTimes(1);

    // Trigger another error — second reconnect should use doubled delay (6s)
    const errorHandler2 = mockAddEventListener.mock.calls.find(
      (call: [string, unknown]) => call[0] === 'error',
    )?.[1] as (event: { status?: number }) => void;
    MockEventSource.mockClear();
    errorHandler2({});

    await jest.advanceTimersByTimeAsync(3000);
    expect(MockEventSource).not.toHaveBeenCalled(); // Not yet — needs 6s

    await jest.advanceTimersByTimeAsync(3000);
    expect(MockEventSource).toHaveBeenCalledTimes(1); // Now at 6s total

    manager.disconnect();
    jest.useRealTimers();
  });

  it('re-reads token from storage on reconnect', async () => {
    jest.useFakeTimers();

    const manager = new SSEConnectionManager();
    await manager.connect(jest.fn());

    // Change the stored token
    mockGetStoredSession.mockResolvedValue('refreshed-token');

    const errorHandler = mockAddEventListener.mock.calls.find(
      (call: [string, unknown]) => call[0] === 'error',
    )?.[1] as (event: { status?: number }) => void;

    MockEventSource.mockClear();
    errorHandler({});

    await jest.advanceTimersByTimeAsync(3000);

    // Should use the new token
    expect(MockEventSource).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Cookie: 'jot_session=refreshed-token' },
      }),
    );

    manager.disconnect();
    jest.useRealTimers();
  });

  it('does not reconnect on 401 errors', async () => {
    jest.useFakeTimers();

    const manager = new SSEConnectionManager();
    await manager.connect(jest.fn());

    const errorHandler = mockAddEventListener.mock.calls.find(
      (call: [string, unknown]) => call[0] === 'error',
    )?.[1] as (event: { status?: number }) => void;

    MockEventSource.mockClear();

    // Trigger a 401 error
    errorHandler({ status: 401 });

    jest.advanceTimersByTime(5000);

    // Should not reconnect
    expect(MockEventSource).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('triggers reconnect after stall timeout with no events', async () => {
    jest.useFakeTimers();

    const manager = new SSEConnectionManager();
    await manager.connect(jest.fn());

    MockEventSource.mockClear();

    // Stall timeout (75s) + one watchdog interval (15s) = watchdog fires at 90s,
    // then schedules reconnect via existing 3s base backoff delay.
    await jest.advanceTimersByTimeAsync(93_000);

    expect(MockEventSource).toHaveBeenCalledTimes(1);

    manager.disconnect();
    jest.useRealTimers();
  });

  it('does not reconnect when keepalive empty-data messages arrive within the stall window', async () => {
    // The server sends `data:\n\n` (empty data event) as a keepalive every 30s so
    // that the message listener fires and resets the watchdog.
    jest.useFakeTimers();

    const manager = new SSEConnectionManager();
    await manager.connect(jest.fn());

    const messageHandler = mockAddEventListener.mock.calls.find(
      (call: [string, unknown]) => call[0] === 'message',
    )?.[1] as (event: { data?: string }) => void;

    MockEventSource.mockClear();

    // Simulate keepalive empty-data events arriving every 30s over 3 minutes.
    for (let i = 0; i < 6; i++) {
      await jest.advanceTimersByTimeAsync(30_000);
      messageHandler({ data: undefined });
    }

    expect(MockEventSource).not.toHaveBeenCalled();

    manager.disconnect();
    jest.useRealTimers();
  });

  it('resets the stall clock when the open event fires', async () => {
    jest.useFakeTimers();

    const manager = new SSEConnectionManager();
    await manager.connect(jest.fn());

    const openHandler = mockAddEventListener.mock.calls.find(
      (call: [string, unknown]) => call[0] === 'open',
    )?.[1] as () => void;

    MockEventSource.mockClear();

    // Advance close to the stall threshold without crossing it.
    await jest.advanceTimersByTimeAsync(70_000);

    // open fires (e.g., a reconnect completes) — resets lastEventAt.
    openHandler();

    // Advance another 30s (100s total since start, only 30s since last open).
    // Watchdog should see < 75s since open and must not reconnect.
    await jest.advanceTimersByTimeAsync(30_000);

    expect(MockEventSource).not.toHaveBeenCalled();

    manager.disconnect();
    jest.useRealTimers();
  });

  it('clears watchdog on disconnect so no reconnect fires after disconnection', async () => {
    jest.useFakeTimers();

    const manager = new SSEConnectionManager();
    await manager.connect(jest.fn());

    manager.disconnect();
    MockEventSource.mockClear();

    // Advance well past stall timeout — watchdog must be cleared.
    await jest.advanceTimersByTimeAsync(120_000);

    expect(MockEventSource).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('watchdog reconnect uses existing exponential backoff path', async () => {
    jest.useFakeTimers();

    const manager = new SSEConnectionManager();
    await manager.connect(jest.fn());

    MockEventSource.mockClear();

    // Let the watchdog fire.
    await jest.advanceTimersByTimeAsync(90_000);

    // Watchdog schedules a reconnect via scheduleReconnect() (3s base delay).
    // EventSource should not be created immediately.
    expect(MockEventSource).not.toHaveBeenCalled();

    // After base reconnect delay the connection is re-established.
    await jest.advanceTimersByTimeAsync(3_000);
    expect(MockEventSource).toHaveBeenCalledTimes(1);

    manager.disconnect();
    jest.useRealTimers();
  });

  it('clears _isConnected when the watchdog triggers a reconnect', async () => {
    jest.useFakeTimers();

    const manager = new SSEConnectionManager();
    await manager.connect(jest.fn());

    const openHandler = mockAddEventListener.mock.calls.find(
      (call: [string, unknown]) => call[0] === 'open',
    )?.[1] as () => void;

    openHandler();
    expect(manager.isConnected()).toBe(true);

    MockEventSource.mockClear();

    // Watchdog fires after stall timeout + one interval.
    await jest.advanceTimersByTimeAsync(90_000);

    expect(manager.isConnected()).toBe(false);

    manager.disconnect();
    jest.useRealTimers();
  });

  it('does not double-schedule reconnect when error fires before the watchdog', async () => {
    // If an error triggers scheduleReconnect() (e.g. at t=60s) and then the
    // watchdog also fires (t=90s), the watchdog must skip rather than cancel
    // the pending error-triggered reconnect and double the backoff delay.
    jest.useFakeTimers();

    const manager = new SSEConnectionManager();
    await manager.connect(jest.fn());

    const errorHandler = mockAddEventListener.mock.calls.find(
      (call: [string, unknown]) => call[0] === 'error',
    )?.[1] as (event: { status?: number }) => void;

    // Error fires at t=60s — schedules a 3s reconnect.
    await jest.advanceTimersByTimeAsync(60_000);
    errorHandler({});
    expect(manager.getReconnectAttempts()).toBe(1);

    // Watchdog fires at t=90s — must NOT increment attempts again.
    await jest.advanceTimersByTimeAsync(30_000);
    expect(manager.getReconnectAttempts()).toBe(1);

    manager.disconnect();
    jest.useRealTimers();
  });
});
