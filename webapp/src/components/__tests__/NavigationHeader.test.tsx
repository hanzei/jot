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
