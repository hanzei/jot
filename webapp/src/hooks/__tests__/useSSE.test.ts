import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSSE, SSEEvent } from '../useSSE';
import { CLIENT_ID } from '@/utils/api';

// Controllable mock for EventSource that exposes lifecycle handlers.
class MockEventSource {
  static instances: MockEventSource[] = [];

  // Mirror the spec's readyState constants.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  url: string;
  withCredentials: boolean;
  readyState = MockEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalled = false;

  constructor(url: string, opts?: EventSourceInit) {
    this.url = url;
    this.withCredentials = opts?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  close() {
    this.closeCalled = true;
    this.readyState = MockEventSource.CLOSED;
  }

  // Test helpers to simulate server events.
  simulateOpen() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.();
  }

  // Simulate an error while the browser is still retrying (CONNECTING) or after
  // it has given up (CLOSED).
  simulateError(readyState: number = MockEventSource.CONNECTING) {
    this.readyState = readyState;
    this.onerror?.();
  }

  simulateMessage(data: unknown) {
    const event = new MessageEvent('message', { data: JSON.stringify(data) });
    this.onmessage?.(event);
  }

  simulateRawMessage(raw: string) {
    const event = new MessageEvent('message', { data: raw });
    this.onmessage?.(event);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalEventSource = (globalThis as any).EventSource;

beforeEach(() => {
  MockEventSource.instances = [];
  // setup.ts defined EventSource as writable so we can assign directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = MockEventSource;
});

afterEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).EventSource = originalEventSource;
});

describe('useSSE', () => {
  describe('connection setup', () => {
    it('creates an EventSource with the correct URL and credentials', () => {
      renderHook(() => useSSE({ onEvent: vi.fn() }));

      expect(MockEventSource.instances).toHaveLength(1);
      const es = MockEventSource.instances[0]!;
      expect(es.url).toBe('/api/v1/events');
      expect(es.withCredentials).toBe(true);
    });

    it('only creates one EventSource on mount', () => {
      renderHook(() => useSSE({ onEvent: vi.fn() }));
      expect(MockEventSource.instances).toHaveLength(1);
    });
  });

  describe('connection status', () => {
    it('starts in the connecting state', () => {
      const { result } = renderHook(() => useSSE({ onEvent: vi.fn() }));
      expect(result.current).toBe('connecting');
    });

    it('reports connected once the stream opens', () => {
      const { result } = renderHook(() => useSSE({ onEvent: vi.fn() }));

      act(() => {
        MockEventSource.instances[0]!.simulateOpen();
      });

      expect(result.current).toBe('connected');
    });

    it('stays connecting when the first connection attempt errors (never opened)', () => {
      const { result } = renderHook(() => useSSE({ onEvent: vi.fn() }));

      act(() => {
        MockEventSource.instances[0]!.simulateError(MockEventSource.CONNECTING);
      });

      expect(result.current).toBe('connecting');
    });

    it('reports reconnecting when a previously-open connection drops and retries', () => {
      const { result } = renderHook(() => useSSE({ onEvent: vi.fn() }));

      act(() => {
        MockEventSource.instances[0]!.simulateOpen();
      });
      act(() => {
        MockEventSource.instances[0]!.simulateError(MockEventSource.CONNECTING);
      });

      expect(result.current).toBe('reconnecting');
    });

    it('reports disconnected once the browser gives up (CLOSED) before ever opening', () => {
      const { result } = renderHook(() => useSSE({ onEvent: vi.fn() }));

      act(() => {
        MockEventSource.instances[0]!.simulateError(MockEventSource.CLOSED);
      });

      expect(result.current).toBe('disconnected');
    });

    it('reports reconnecting when a previously-open connection reaches CLOSED', () => {
      const { result } = renderHook(() => useSSE({ onEvent: vi.fn() }));

      act(() => {
        MockEventSource.instances[0]!.simulateOpen();
      });
      act(() => {
        MockEventSource.instances[0]!.simulateError(MockEventSource.CLOSED);
      });

      expect(result.current).toBe('reconnecting');
    });
  });

  describe('manual reconnect after the browser gives up (CLOSED)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('opens a fresh EventSource after the backoff delay', () => {
      renderHook(() => useSSE({ onEvent: vi.fn() }));

      act(() => {
        MockEventSource.instances[0]!.simulateError(MockEventSource.CLOSED);
      });
      // The dead EventSource is closed and no new one exists yet.
      expect(MockEventSource.instances[0]!.closeCalled).toBe(true);
      expect(MockEventSource.instances).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockEventSource.instances).toHaveLength(2);
      expect(MockEventSource.instances[1]!.url).toBe('/api/v1/events');
    });

    it('returns to connected once the reconnect opens (banner clears)', () => {
      const { result } = renderHook(() => useSSE({ onEvent: vi.fn() }));

      act(() => {
        MockEventSource.instances[0]!.simulateError(MockEventSource.CLOSED);
      });
      expect(result.current).toBe('disconnected');

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      act(() => {
        MockEventSource.instances[1]!.simulateOpen();
      });

      expect(result.current).toBe('connected');
    });

    it('grows the backoff delay on repeated failures and resets after a success', () => {
      renderHook(() => useSSE({ onEvent: vi.fn() }));

      // First failure → retry after 1s.
      act(() => {
        MockEventSource.instances[0]!.simulateError(MockEventSource.CLOSED);
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockEventSource.instances).toHaveLength(2);

      // Second failure → retry after 2s (not yet at 1s).
      act(() => {
        MockEventSource.instances[1]!.simulateError(MockEventSource.CLOSED);
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockEventSource.instances).toHaveLength(2);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockEventSource.instances).toHaveLength(3);

      // A successful open resets the backoff back to 1s.
      act(() => {
        MockEventSource.instances[2]!.simulateOpen();
      });
      act(() => {
        MockEventSource.instances[2]!.simulateError(MockEventSource.CLOSED);
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockEventSource.instances).toHaveLength(4);
    });

    it('does not open a new EventSource after unmount', () => {
      const { unmount } = renderHook(() => useSSE({ onEvent: vi.fn() }));

      act(() => {
        MockEventSource.instances[0]!.simulateError(MockEventSource.CLOSED);
      });
      unmount();
      act(() => {
        vi.advanceTimersByTime(60000);
      });

      expect(MockEventSource.instances).toHaveLength(1);
    });
  });

  describe('onConnected callback', () => {
    it('calls onConnected when the connection opens', () => {
      const onConnected = vi.fn();
      renderHook(() => useSSE({ onEvent: vi.fn(), onConnected }));

      act(() => {
        MockEventSource.instances[0]!.simulateOpen();
      });

      expect(onConnected).toHaveBeenCalledTimes(1);
    });

    it('does not throw when onConnected is not provided', () => {
      renderHook(() => useSSE({ onEvent: vi.fn() }));

      expect(() => {
        act(() => MockEventSource.instances[0]!.simulateOpen());
      }).not.toThrow();
    });
  });

  describe('onEvent callback', () => {
    it('calls onEvent with parsed event data on message', () => {
      const onEvent = vi.fn();
      renderHook(() => useSSE({ onEvent }));

      const event: SSEEvent = {
        type: 'note_created',
        source_user_id: 'user1',
        data: { note_id: 'note123', note: null },
      };

      act(() => {
        MockEventSource.instances[0]!.simulateMessage(event);
      });

      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(onEvent).toHaveBeenCalledWith(event);
    });

    it('drops events whose client_id matches CLIENT_ID', () => {
      const onEvent = vi.fn();
      renderHook(() => useSSE({ onEvent }));

      const event: SSEEvent = {
        type: 'note_updated',
        source_user_id: 'user1',
        client_id: CLIENT_ID,
        data: { note_id: 'note123', note: null },
      };

      act(() => {
        MockEventSource.instances[0]!.simulateMessage(event);
      });

      expect(onEvent).not.toHaveBeenCalled();
    });

    it('passes through events whose client_id differs from CLIENT_ID', () => {
      const onEvent = vi.fn();
      renderHook(() => useSSE({ onEvent }));

      const event: SSEEvent = {
        type: 'note_updated',
        source_user_id: 'user1',
        client_id: 'other-tab-id',
        data: { note_id: 'note123', note: null },
      };

      act(() => {
        MockEventSource.instances[0]!.simulateMessage(event);
      });

      expect(onEvent).toHaveBeenCalledWith(event);
    });

    it('passes through events with no client_id', () => {
      const onEvent = vi.fn();
      renderHook(() => useSSE({ onEvent }));

      const event: SSEEvent = {
        type: 'note_updated',
        source_user_id: 'user1',
        data: { note_id: 'note123', note: null },
      };

      act(() => {
        MockEventSource.instances[0]!.simulateMessage(event);
      });

      expect(onEvent).toHaveBeenCalledWith(event);
    });

    it('ignores malformed JSON without throwing', () => {
      const onEvent = vi.fn();
      renderHook(() => useSSE({ onEvent }));

      expect(() => {
        act(() => {
          MockEventSource.instances[0]!.simulateRawMessage('not valid json {{{');
        });
      }).not.toThrow();

      expect(onEvent).not.toHaveBeenCalled();
    });

    it('ignores empty message data', () => {
      const onEvent = vi.fn();
      renderHook(() => useSSE({ onEvent }));

      expect(() => {
        act(() => {
          MockEventSource.instances[0]!.simulateRawMessage('');
        });
      }).not.toThrow();

      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('closes EventSource when component unmounts', () => {
      const { unmount } = renderHook(() => useSSE({ onEvent: vi.fn() }));

      unmount();

      expect(MockEventSource.instances[0]!.closeCalled).toBe(true);
    });

    it('calls close exactly once on unmount', () => {
      const { unmount } = renderHook(() => useSSE({ onEvent: vi.fn() }));
      const closeSpy = vi.spyOn(MockEventSource.instances[0]!, 'close');

      unmount();

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('callback ref stability', () => {
    it('does not create a new EventSource when onEvent callback reference changes', () => {
      let handler = vi.fn();
      const { rerender } = renderHook(({ cb }) => useSSE({ onEvent: cb }), {
        initialProps: { cb: handler },
      });

      handler = vi.fn();
      rerender({ cb: handler });

      // Still only the original EventSource.
      expect(MockEventSource.instances).toHaveLength(1);
    });

    it('uses the latest onEvent callback after rerender', () => {
      const firstHandler = vi.fn();
      const secondHandler = vi.fn();

      const { rerender } = renderHook(({ cb }) => useSSE({ onEvent: cb }), {
        initialProps: { cb: firstHandler },
      });

      rerender({ cb: secondHandler });

      // Trigger an event after rerender — the latest callback should fire.
      const event: SSEEvent = {
        type: 'note_updated',
        source_user_id: 'u1',
        data: { note_id: 'n1', note: null },
      };
      act(() => {
        MockEventSource.instances[0]!.simulateMessage(event);
      });

      expect(firstHandler).not.toHaveBeenCalled();
      expect(secondHandler).toHaveBeenCalledWith(event);
    });
  });
});
