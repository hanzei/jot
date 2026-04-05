import { render, screen, act, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ToastProvider } from '../Toast'
import { useToast } from '@/hooks/useToast'
import {
  TOAST_ACTION_AUTO_DISMISS_MS,
  TOAST_AUTO_DISMISS_MS,
  TOAST_EXIT_ANIMATION_MS,
} from '@/utils/toastTiming'

const actionSpy = vi.fn()

function ToastHarness() {
  const { showToast } = useToast()

  return (
    <div>
      <button onClick={() => showToast('Standard toast', 'success')}>Show standard toast</button>
      <button
        onClick={() => showToast('Undo toast', 'success', { label: 'Undo', onClick: actionSpy })}
      >
        Show undo toast
      </button>
    </div>
  )
}

describe('Toast auto dismiss durations', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    actionSpy.mockClear()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('auto dismisses standard toasts after configured duration', () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show standard toast' }))
    expect(screen.getByText('Standard toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS)
    })
    expect(screen.getByText('Standard toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_ANIMATION_MS)
    })
    expect(screen.queryByText('Standard toast')).not.toBeInTheDocument()
  })

  it('keeps action toasts visible longer before dismissing', () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show undo toast' }))
    expect(screen.getByText('Undo toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(TOAST_ACTION_AUTO_DISMISS_MS - 1000)
    })
    expect(screen.getByText('Undo toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText('Undo toast')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_ANIMATION_MS)
    })
    expect(screen.queryByText('Undo toast')).not.toBeInTheDocument()
  })

  it('dismisses manually when close button is clicked', () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show standard toast' }))
    const toast = screen.getByTestId('toast')
    const closeButton = within(toast).getByRole('button', { name: /close/i })

    fireEvent.click(closeButton)
    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_ANIMATION_MS)
    })

    expect(screen.queryByText('Standard toast')).not.toBeInTheDocument()
  })

  it('runs action callback and dismisses immediately when action is clicked', () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show undo toast' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(actionSpy).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Undo toast')).not.toBeInTheDocument()
  })
})
