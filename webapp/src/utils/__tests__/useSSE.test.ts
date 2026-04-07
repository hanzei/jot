import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSSE, SSEEvent } from '../useSSE'
import { CLIENT_ID } from '../api'

// Controllable mock for EventSource that exposes lifecycle handlers.
class MockEventSource {
  static instances: MockEventSource[] = []

  url: string
  withCredentials: boolean
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  closeCalled = false

  constructor(url: string, opts?: EventSourceInit) {
    this.url = url
    this.withCredentials = opts?.withCredentials ?? false
    MockEventSource.instances.push(this)
  }

  close() {
    this.closeCalled = true
  }

  // Test helpers to simulate server events.
  simulateOpen() {
    this.onopen?.()
  }

  simulateMessage(data: unknown) {
    const event = new MessageEvent('message', { data: JSON.stringify(data) })
    this.onmessage?.(event)
  }

  simulateRawMessage(raw: string) {
    const event = new MessageEvent('message', { data: raw })
    this.onmessage?.(event)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalEventSource = (globalThis as any).EventSource

beforeEach(() => {
  MockEventSource.instances = []
  // setup.ts defined EventSource as writable so we can assign directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).EventSource = MockEventSource
})

afterEach(() => {
  vi.clearAllMocks()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).EventSource = originalEventSource
})

describe('useSSE', () => {
  describe('connection setup', () => {
    it('creates an EventSource with the correct URL and credentials', () => {
      renderHook(() => useSSE({ onEvent: vi.fn() }))

      expect(MockEventSource.instances).toHaveLength(1)
      const es = MockEventSource.instances[0]
      expect(es.url).toBe('/api/v1/events')
      expect(es.withCredentials).toBe(true)
    })

    it('only creates one EventSource on mount', () => {
      renderHook(() => useSSE({ onEvent: vi.fn() }))
      expect(MockEventSource.instances).toHaveLength(1)
    })
  })

  describe('onConnected callback', () => {
    it('calls onConnected when the connection opens', () => {
      const onConnected = vi.fn()
      renderHook(() => useSSE({ onEvent: vi.fn(), onConnected }))

      act(() => {
        MockEventSource.instances[0].simulateOpen()
      })

      expect(onConnected).toHaveBeenCalledTimes(1)
    })

    it('does not throw when onConnected is not provided', () => {
      renderHook(() => useSSE({ onEvent: vi.fn() }))

      expect(() => {
        act(() => MockEventSource.instances[0].simulateOpen())
      }).not.toThrow()
    })
  })

  describe('onEvent callback', () => {
    it('calls onEvent with parsed event data on message', () => {
      const onEvent = vi.fn()
      renderHook(() => useSSE({ onEvent }))

      const event: SSEEvent = {
        type: 'note_created',
        source_user_id: 'user1',
        data: { note_id: 'note123', note: null },
      }

      act(() => {
        MockEventSource.instances[0].simulateMessage(event)
      })

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent).toHaveBeenCalledWith(event)
    })

    it('drops events whose client_id matches CLIENT_ID', () => {
      const onEvent = vi.fn()
      renderHook(() => useSSE({ onEvent }))

      const event: SSEEvent = {
        type: 'note_updated',
        source_user_id: 'user1',
        client_id: CLIENT_ID,
        data: { note_id: 'note123', note: null },
      }

      act(() => {
        MockEventSource.instances[0].simulateMessage(event)
      })

      expect(onEvent).not.toHaveBeenCalled()
    })

    it('passes through events whose client_id differs from CLIENT_ID', () => {
      const onEvent = vi.fn()
      renderHook(() => useSSE({ onEvent }))

      const event: SSEEvent = {
        type: 'note_updated',
        source_user_id: 'user1',
        client_id: 'other-tab-id',
        data: { note_id: 'note123', note: null },
      }

      act(() => {
        MockEventSource.instances[0].simulateMessage(event)
      })

      expect(onEvent).toHaveBeenCalledWith(event)
    })

    it('passes through events with no client_id', () => {
      const onEvent = vi.fn()
      renderHook(() => useSSE({ onEvent }))

      const event: SSEEvent = {
        type: 'note_updated',
        source_user_id: 'user1',
        data: { note_id: 'note123', note: null },
      }

      act(() => {
        MockEventSource.instances[0].simulateMessage(event)
      })

      expect(onEvent).toHaveBeenCalledWith(event)
    })

    it('ignores malformed JSON without throwing', () => {
      const onEvent = vi.fn()
      renderHook(() => useSSE({ onEvent }))

      expect(() => {
        act(() => {
          MockEventSource.instances[0].simulateRawMessage('not valid json {{{')
        })
      }).not.toThrow()

      expect(onEvent).not.toHaveBeenCalled()
    })

    it('ignores empty message data', () => {
      const onEvent = vi.fn()
      renderHook(() => useSSE({ onEvent }))

      expect(() => {
        act(() => {
          MockEventSource.instances[0].simulateRawMessage('')
        })
      }).not.toThrow()

      expect(onEvent).not.toHaveBeenCalled()
    })
  })

  describe('cleanup', () => {
    it('closes EventSource when component unmounts', () => {
      const { unmount } = renderHook(() => useSSE({ onEvent: vi.fn() }))

      unmount()

      expect(MockEventSource.instances[0].closeCalled).toBe(true)
    })

    it('calls close exactly once on unmount', () => {
      const { unmount } = renderHook(() => useSSE({ onEvent: vi.fn() }))
      const closeSpy = vi.spyOn(MockEventSource.instances[0], 'close')

      unmount()

      expect(closeSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('callback ref stability', () => {
    it('does not create a new EventSource when onEvent callback reference changes', () => {
      let handler = vi.fn()
      const { rerender } = renderHook(({ cb }) => useSSE({ onEvent: cb }), {
        initialProps: { cb: handler },
      })

      handler = vi.fn()
      rerender({ cb: handler })

      // Still only the original EventSource.
      expect(MockEventSource.instances).toHaveLength(1)
    })

    it('uses the latest onEvent callback after rerender', () => {
      const firstHandler = vi.fn()
      const secondHandler = vi.fn()

      const { rerender } = renderHook(({ cb }) => useSSE({ onEvent: cb }), {
        initialProps: { cb: firstHandler },
      })

      rerender({ cb: secondHandler })

      // Trigger an event after rerender — the latest callback should fire.
      const event: SSEEvent = {
        type: 'note_updated',
        source_user_id: 'u1',
        data: { note_id: 'n1', note: null },
      }
      act(() => {
        MockEventSource.instances[0].simulateMessage(event)
      })

      expect(firstHandler).not.toHaveBeenCalled()
      expect(secondHandler).toHaveBeenCalledWith(event)
    })
  })
})
