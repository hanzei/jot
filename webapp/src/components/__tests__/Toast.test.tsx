import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ToastProvider } from '../Toast'
import { useToast } from '@/hooks/useToast'

function ToastHarness() {
  const { showToast } = useToast()

  return (
    <div>
      <button onClick={() => showToast('Standard toast', 'success')}>Show standard toast</button>
      <button
        onClick={() => showToast('Undo toast', 'success', { label: 'Undo', onClick: () => {} })}
      >
        Show undo toast
      </button>
    </div>
  )
}

describe('Toast auto dismiss durations', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('auto dismisses standard toasts after 4 seconds', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Show standard toast' }))
    expect(screen.getByText('Standard toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.getByText('Standard toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByText('Standard toast')).not.toBeInTheDocument()
  })

  it('keeps action toasts visible longer before dismissing', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Show undo toast' }))
    expect(screen.getByText('Undo toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(screen.getByText('Undo toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText('Undo toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByText('Undo toast')).not.toBeInTheDocument()
  })
})
