import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import NavigationHeader from '../NavigationHeader'
import SearchBar from '../SearchBar'

vi.mock('@/utils/auth', () => ({
  getUser: vi.fn(() => ({
    id: 'user-1',
    username: 'alice',
    first_name: 'Alice',
    last_name: 'Appleseed',
    has_profile_icon: false,
    updated_at: '2026-03-20T00:00:00.000Z',
  })),
}))

const defaultMatchMedia = window.matchMedia

const mockMatchMedia = (viewport: 'mobile' | 'desktop') => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches:
      query === '(min-width: 640px)'
        ? viewport === 'desktop'
        : query === '(max-width: 639px)'
          ? viewport === 'mobile'
          : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
}

const renderHeader = (initialValue = '') => {
  const Harness = () => {
    const [value, setValue] = useState(initialValue)

    return (
      <MemoryRouter>
        <NavigationHeader
          onLogout={vi.fn()}
          searchBar={<SearchBar value={value} onChange={setValue} />}
        />
      </MemoryRouter>
    )
  }

  return render(<Harness />)
}

describe('NavigationHeader', () => {
  afterEach(() => {
    vi.stubGlobal('matchMedia', defaultMatchMedia)
  })

  it('shows a search icon instead of the input on mobile until expanded', async () => {
    mockMatchMedia('mobile')
    const user = userEvent.setup()

    renderHeader()

    expect(screen.getByRole('button', { name: 'Open search' })).toBeVisible()
    expect(screen.getByLabelText('Search notes')).not.toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Open search' }))

    const input = await screen.findByLabelText('Search notes')
    expect(input).toBeVisible()

    await waitFor(() => {
      expect(input).toHaveFocus()
    })
  })

  it('starts expanded on mobile when a search query is already active', () => {
    mockMatchMedia('mobile')

    renderHeader('hello')

    expect(screen.getByLabelText('Search notes')).toHaveValue('hello')
    expect(screen.getByRole('button', { name: 'Close search' })).toBeVisible()
  })

  it('collapses the mobile search when Escape is pressed', async () => {
    mockMatchMedia('mobile')
    const user = userEvent.setup()

    renderHeader()

    await user.click(screen.getByRole('button', { name: 'Open search' }))
    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open search' })).toHaveFocus()
    })

    expect(screen.getByLabelText('Search notes')).not.toBeVisible()
  })

  it('collapses the mobile search when the close button is clicked', async () => {
    mockMatchMedia('mobile')
    const user = userEvent.setup()

    renderHeader('hello')

    await user.click(screen.getByRole('button', { name: 'Close search' }))

    expect(screen.getByLabelText('Search notes')).not.toBeVisible()
    expect(screen.getByRole('button', { name: 'Open search' })).toBeVisible()
  })

  it('collapses the mobile search after clearing and blurring the input', async () => {
    mockMatchMedia('mobile')
    const user = userEvent.setup()

    renderHeader('hello')

    const input = screen.getByLabelText('Search notes')
    await user.clear(input)
    fireEvent.blur(input)

    expect(screen.getByLabelText('Search notes')).not.toBeVisible()
    expect(screen.getByRole('button', { name: 'Open search' })).toBeVisible()
  })

  it('keeps the desktop search bar always visible', () => {
    mockMatchMedia('desktop')

    renderHeader()

    expect(screen.getByLabelText('Search notes')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Open search' })).not.toBeInTheDocument()
  })
})
