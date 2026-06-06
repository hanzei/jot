import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { SSEStatusIndicator } from '../SSEStatusIndicator'

// The indicator waits SHOW_DELAY_MS (2000ms) before appearing.
const SHOW_DELAY_MS = 2000

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
}

describe('SSEStatusIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setOnline(true)
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('renders nothing while connected', () => {
    render(<SSEStatusIndicator status="connected" />)
    act(() => vi.advanceTimersByTime(SHOW_DELAY_MS))
    expect(screen.queryByTestId('sse-status-indicator')).not.toBeInTheDocument()
  })

  it('does not show immediately on a brief interruption', () => {
    render(<SSEStatusIndicator status="connecting" />)
    expect(screen.queryByTestId('sse-status-indicator')).not.toBeInTheDocument()
  })

  it('shows a reconnecting indicator after the delay while connecting', () => {
    render(<SSEStatusIndicator status="connecting" />)
    act(() => vi.advanceTimersByTime(SHOW_DELAY_MS))
    expect(screen.getByTestId('sse-status-indicator')).toBeInTheDocument()
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument()
  })

  it('shows a connection-lost indicator after the delay when disconnected', () => {
    render(<SSEStatusIndicator status="disconnected" />)
    act(() => vi.advanceTimersByTime(SHOW_DELAY_MS))
    expect(screen.getByText('Connection lost')).toBeInTheDocument()
  })

  it('hides again once the connection recovers', () => {
    const { rerender } = render(<SSEStatusIndicator status="connecting" />)
    act(() => vi.advanceTimersByTime(SHOW_DELAY_MS))
    expect(screen.getByTestId('sse-status-indicator')).toBeInTheDocument()

    rerender(<SSEStatusIndicator status="connected" />)
    expect(screen.queryByTestId('sse-status-indicator')).not.toBeInTheDocument()
  })

  it('stays hidden when the browser is offline (OfflineNotification covers it)', () => {
    setOnline(false)
    render(<SSEStatusIndicator status="connecting" />)
    act(() => vi.advanceTimersByTime(SHOW_DELAY_MS))
    expect(screen.queryByTestId('sse-status-indicator')).not.toBeInTheDocument()
  })
})
