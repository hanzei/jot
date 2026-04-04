import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import NavigationHeader from '../NavigationHeader'
import { buildMobileDeepLink } from '@/utils/deepLink'
import { isMobileAppBannerDismissed } from '@/utils/mobileAppBanner'
import * as deepLinkModule from '@/utils/deepLink'

vi.mock('@/utils/auth', () => ({
  getUser: vi.fn(() => null),
}))

describe('NavigationHeader', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows keyboard shortcuts menu item when callback is provided', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <NavigationHeader onLogout={vi.fn()} onOpenKeyboardShortcuts={vi.fn()} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Profile menu' }))
    expect(screen.getByRole('menuitem', { name: /Keyboard shortcuts/ })).toBeInTheDocument()
  })

  it('does not show keyboard shortcuts menu item when callback is missing', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <NavigationHeader onLogout={vi.fn()} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Profile menu' }))
    expect(screen.queryByRole('menuitem', { name: /Keyboard shortcuts/ })).not.toBeInTheDocument()
  })

  it('calls keyboard shortcuts callback from profile menu', () => {
    const onOpenKeyboardShortcuts = vi.fn()
    render(
      <MemoryRouter initialEntries={['/']}>
        <NavigationHeader onLogout={vi.fn()} onOpenKeyboardShortcuts={onOpenKeyboardShortcuts} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Profile menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Keyboard shortcuts/ }))
    expect(onOpenKeyboardShortcuts).toHaveBeenCalledTimes(1)
  })

  it('shows mobile app banner by default', () => {
    render(
      <MemoryRouter initialEntries={['/notes/note-1']}>
        <NavigationHeader onLogout={vi.fn()} />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('open-mobile-app-banner')).toBeInTheDocument()
    expect(screen.getByTestId('open-mobile-app-link')).toHaveAttribute('href', buildMobileDeepLink('/notes/note-1', window.location.origin))
  })

  it('hides mobile app banner when deep link cannot be built', async () => {
    const spy = vi.spyOn(deepLinkModule, 'buildMobileDeepLink').mockReturnValue(null)
    render(
      <MemoryRouter initialEntries={['/notes/note-1']}>
        <NavigationHeader onLogout={vi.fn()} />
      </MemoryRouter>,
    )

    expect(screen.queryByTestId('open-mobile-app-banner')).not.toBeInTheDocument()
    spy.mockRestore()
  })

  it('dismisses banner and persists state on this device', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <NavigationHeader onLogout={vi.fn()} />
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByTestId('dismiss-mobile-app-banner'))

    expect(screen.queryByTestId('open-mobile-app-banner')).not.toBeInTheDocument()
    expect(isMobileAppBannerDismissed()).toBe(true)
  })
})
