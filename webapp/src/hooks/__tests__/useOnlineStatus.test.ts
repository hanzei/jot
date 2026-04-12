import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOnlineStatus } from '../useOnlineStatus'

// Mock navigator.onLine
const mockNavigator = {
  onLine: true,
}
Object.defineProperty(global, 'navigator', {
  value: mockNavigator,
  writable: true,
})

// Mock window event methods
const mockAddEventListener = vi.fn()
const mockRemoveEventListener = vi.fn()
Object.defineProperty(global.window, 'addEventListener', {
  value: mockAddEventListener,
  writable: true,
})
Object.defineProperty(global.window, 'removeEventListener', {
  value: mockRemoveEventListener,
  writable: true,
})

describe('useOnlineStatus Hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigator.onLine = true
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Initial State', () => {
    it('returns true when navigator.onLine is true', () => {
      mockNavigator.onLine = true

      const { result } = renderHook(() => useOnlineStatus())

      expect(result.current).toBe(true)
    })

    it('returns false when navigator.onLine is false', () => {
      mockNavigator.onLine = false

      const { result } = renderHook(() => useOnlineStatus())

      expect(result.current).toBe(false)
    })

    it('handles undefined navigator.onLine gracefully', () => {
      // Save original value
      const original = mockNavigator.onLine

      Object.defineProperty(mockNavigator, 'onLine', {
        value: undefined,
        configurable: true,
      })

      const { result } = renderHook(() => useOnlineStatus())

      expect(result.current).toBe(undefined) // Returns actual value from navigator.onLine

      // Restore original value
      Object.defineProperty(mockNavigator, 'onLine', {
        value: original,
        configurable: true,
      })
    })

    it('handles null navigator.onLine gracefully', () => {
      // Save original value
      const original = mockNavigator.onLine

      Object.defineProperty(mockNavigator, 'onLine', {
        value: null,
        configurable: true,
      })

      const { result } = renderHook(() => useOnlineStatus())

      expect(result.current).toBe(null) // Returns actual value from navigator.onLine

      // Restore original value
      Object.defineProperty(mockNavigator, 'onLine', {
        value: original,
        configurable: true,
      })
    })
  })

  describe('Event Listeners', () => {
    it('sets up online and offline event listeners on mount', () => {
      renderHook(() => useOnlineStatus())

      expect(mockAddEventListener).toHaveBeenCalledTimes(2)
      expect(mockAddEventListener).toHaveBeenCalledWith('online', expect.any(Function))
      expect(mockAddEventListener).toHaveBeenCalledWith('offline', expect.any(Function))
    })

    it('removes event listeners on unmount', () => {
      const { unmount } = renderHook(() => useOnlineStatus())

      unmount()

      expect(mockRemoveEventListener).toHaveBeenCalledTimes(2)
      expect(mockRemoveEventListener).toHaveBeenCalledWith('online', expect.any(Function))
      expect(mockRemoveEventListener).toHaveBeenCalledWith('offline', expect.any(Function))
    })

    it('uses the same function references for add and remove', () => {
      const { unmount } = renderHook(() => useOnlineStatus())

      const addOnlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'online')![1]
      const addOfflineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'offline')![1]

      unmount()

      const removeOnlineHandler = mockRemoveEventListener.mock.calls.find(call => call[0] === 'online')![1]
      const removeOfflineHandler = mockRemoveEventListener.mock.calls.find(call => call[0] === 'offline')![1]

      expect(addOnlineHandler).toBe(removeOnlineHandler)
      expect(addOfflineHandler).toBe(removeOfflineHandler)
    })
  })

  describe('Online/Offline State Changes', () => {
    it('updates to true when online event is triggered', () => {
      mockNavigator.onLine = false

      const { result } = renderHook(() => useOnlineStatus())

      expect(result.current).toBe(false)

      // Get the online event handler
      const onlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'online')![1]

      act(() => {
        onlineHandler()
      })

      expect(result.current).toBe(true)
    })

    it('updates to false when offline event is triggered', () => {
      mockNavigator.onLine = true

      const { result } = renderHook(() => useOnlineStatus())

      expect(result.current).toBe(true)

      // Get the offline event handler
      const offlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'offline')![1]

      act(() => {
        offlineHandler()
      })

      expect(result.current).toBe(false)
    })

    it('handles rapid online/offline transitions', () => {
      const { result } = renderHook(() => useOnlineStatus())

      const onlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'online')![1]
      const offlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'offline')![1]

      // Rapid state changes
      act(() => {
        offlineHandler()
      })
      expect(result.current).toBe(false)

      act(() => {
        onlineHandler()
      })
      expect(result.current).toBe(true)

      act(() => {
        offlineHandler()
      })
      expect(result.current).toBe(false)

      act(() => {
        onlineHandler()
      })
      expect(result.current).toBe(true)
    })

    it('handles multiple event triggers correctly', () => {
      const { result } = renderHook(() => useOnlineStatus())

      const onlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'online')![1]

      // Multiple online events shouldn't cause issues
      act(() => {
        onlineHandler()
        onlineHandler()
        onlineHandler()
      })

      expect(result.current).toBe(true)
    })
  })

  describe('Edge Cases and Error Scenarios', () => {
    it('returns exact value when navigator.onLine is falsy', () => {
      // Test the core logic with different falsy values
      const testValues = [false, null, undefined, 0, '']

      testValues.forEach(value => {
        const original = mockNavigator.onLine
        Object.defineProperty(mockNavigator, 'onLine', {
          value: value,
          configurable: true,
        })

        const { result, unmount } = renderHook(() => useOnlineStatus())
        expect(result.current).toBe(value) // Returns exact value from navigator.onLine

        unmount()

        // Restore original value
        Object.defineProperty(mockNavigator, 'onLine', {
          value: original,
          configurable: true,
        })
      })
    })

    it('handles multiple instances of the hook correctly', () => {
      const { result: result1, unmount: unmount1 } = renderHook(() => useOnlineStatus())
      const { result: result2, unmount: unmount2 } = renderHook(() => useOnlineStatus())

      expect(result1.current).toBe(result2.current)

      unmount1()
      unmount2()
    })

    it('maintains consistent state across re-renders', () => {
      const { result, rerender } = renderHook(() => useOnlineStatus())

      const initialValue = result.current

      // Force re-render
      rerender()

      expect(result.current).toBe(initialValue)
    })
  })

  describe('Browser Compatibility', () => {
    it('handles browsers without online/offline event support', () => {
      // Mock browsers that don't support these events
      mockAddEventListener.mockImplementation(() => {
        // Simulate events not being supported by doing nothing
        return
      })

      const { result } = renderHook(() => useOnlineStatus())

      // Should still return initial navigator.onLine value
      expect(result.current).toBe(true)
    })

    it('handles basic navigator.onLine variations', () => {
      // Test different initial values of navigator.onLine
      const testCases = [true, false]

      testCases.forEach(onlineValue => {
        mockNavigator.onLine = onlineValue
        const { result, unmount } = renderHook(() => useOnlineStatus())
        expect(result.current).toBe(onlineValue)
        unmount()
      })
    })

    it('maintains hook functionality across different scenarios', () => {
      // Test that the hook works consistently
      const { result } = renderHook(() => useOnlineStatus())

      // Should initialize with navigator.onLine
      expect(result.current).toBe(mockNavigator.onLine)

      // Should set up event listeners
      expect(mockAddEventListener).toHaveBeenCalledWith('online', expect.any(Function))
      expect(mockAddEventListener).toHaveBeenCalledWith('offline', expect.any(Function))
    })
  })

  describe('Performance Considerations', () => {
    it('does not cause memory leaks with proper cleanup', () => {
      const hooks: ReturnType<typeof renderHook>[] = []

      // Create multiple hook instances
      for (let i = 0; i < 100; i++) {
        hooks.push(renderHook(() => useOnlineStatus()))
      }

      // Unmount all
      hooks.forEach(hook => hook.unmount())

      // Each hook should have cleaned up its listeners
      expect(mockRemoveEventListener).toHaveBeenCalledTimes(200) // 2 events × 100 instances
    })

    it('handles frequent status changes efficiently', () => {
      const { result } = renderHook(() => useOnlineStatus())

      const onlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'online')![1]
      const offlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'offline')![1]

      // Simulate many rapid changes
      const startTime = performance.now()

      act(() => {
        for (let i = 0; i < 1000; i++) {
          if (i % 2 === 0) {
            offlineHandler()
          } else {
            onlineHandler()
          }
        }
      })

      const endTime = performance.now()
      const duration = endTime - startTime

      // Should complete quickly (arbitrary threshold)
      expect(duration).toBeLessThan(100)
      expect(result.current).toBe(true) // Last change was online
    })

    it('maintains consistent behavior across re-renders', () => {
      let renderCount = 0

      const { result, rerender } = renderHook(() => {
        renderCount++
        return useOnlineStatus()
      })

      const initialValue = result.current

      // Force multiple re-renders
      for (let i = 0; i < 10; i++) {
        rerender()
      }

      expect(renderCount).toBe(11) // Initial + 10 re-renders
      expect(result.current).toBe(initialValue)

      // Event listeners should only be set up once
      expect(mockAddEventListener).toHaveBeenCalledTimes(2)
    })
  })

  describe('Real-world Scenarios', () => {
    it('simulates going offline during network request', () => {
      const { result } = renderHook(() => useOnlineStatus())

      expect(result.current).toBe(true) // Initially online

      // Simulate network disconnection
      const offlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'offline')![1]

      act(() => {
        offlineHandler()
      })

      expect(result.current).toBe(false)
    })

    it('simulates mobile app going to background and back', () => {
      const { result } = renderHook(() => useOnlineStatus())

      // App goes to background (might lose connection)
      const offlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'offline')![1]

      act(() => {
        offlineHandler()
      })

      expect(result.current).toBe(false)

      // App comes back to foreground (connection restored)
      const onlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'online')![1]

      act(() => {
        onlineHandler()
      })

      expect(result.current).toBe(true)
    })

    it('simulates unstable connection with frequent disconnects', () => {
      const { result } = renderHook(() => useOnlineStatus())

      const onlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'online')![1]
      const offlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'offline')![1]

      // Simulate unstable connection
      const events = [
        { handler: offlineHandler, expected: false },
        { handler: onlineHandler, expected: true },
        { handler: offlineHandler, expected: false },
        { handler: offlineHandler, expected: false }, // Double offline
        { handler: onlineHandler, expected: true },
        { handler: onlineHandler, expected: true }, // Double online
        { handler: offlineHandler, expected: false },
      ]

      events.forEach(({ handler, expected }) => {
        act(() => {
          handler()
        })
        expect(result.current).toBe(expected)
      })
    })

    it('handles component unmounting during network transitions', () => {
      const { result, unmount } = renderHook(() => useOnlineStatus())

      const offlineHandler = mockAddEventListener.mock.calls.find(call => call[0] === 'offline')![1]

      // Start network transition
      act(() => {
        offlineHandler()
      })

      expect(result.current).toBe(false)

      // Unmount during transition
      expect(() => {
        unmount()
      }).not.toThrow()

      // Should have cleaned up properly
      expect(mockRemoveEventListener).toHaveBeenCalledTimes(2)
    })
  })
})
