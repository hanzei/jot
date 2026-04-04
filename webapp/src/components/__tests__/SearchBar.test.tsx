import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, createEvent } from '@testing-library/react'
import { VALIDATION } from '@jot/shared'
import SearchBar from '../SearchBar'

describe('SearchBar', () => {
  it('has maxLength set to SEARCH_QUERY_MAX_LENGTH', () => {
    render(<SearchBar value="" onChange={vi.fn()} />)
    expect(screen.getByRole('textbox')).toHaveAttribute('maxLength', String(VALIDATION.SEARCH_QUERY_MAX_LENGTH))
  })

  it('renders shortcut hint when provided', () => {
    render(
      <SearchBar
        value=""
        onChange={vi.fn()}
        shortcutHint="Ctrl + F"
      />
    )

    expect(screen.getByTestId('search-shortcut-hint')).toHaveTextContent('Ctrl + F')
  })

  it('clears the input value when Escape is pressed', () => {
    const onChange = vi.fn()

    render(
      <SearchBar
        value="query"
        onChange={onChange}
      />
    )

    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onChange).toHaveBeenCalledWith('')
  })

  it('does not clear when Escape is pressed on an empty value', () => {
    const onChange = vi.fn()

    render(
      <SearchBar
        value=""
        onChange={onChange}
      />
    )

    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('stops Escape propagation when configured', () => {
    const parentKeyDown = vi.fn()
    const onChange = vi.fn()

    render(
      <div onKeyDown={parentKeyDown}>
        <SearchBar
          value="query"
          onChange={onChange}
          stopEscapePropagation={true}
        />
      </div>
    )

    const input = screen.getByRole('textbox')
    const escapeEvent = createEvent.keyDown(input, { key: 'Escape' })
    fireEvent(input, escapeEvent)

    expect(onChange).toHaveBeenCalledWith('')
    expect(parentKeyDown).not.toHaveBeenCalled()
    expect(escapeEvent.defaultPrevented).toBe(true)
  })

  it('keeps Escape bubbling by default', () => {
    const parentKeyDown = vi.fn()
    const onChange = vi.fn()

    render(
      <div onKeyDown={parentKeyDown}>
        <SearchBar
          value="query"
          onChange={onChange}
        />
      </div>
    )

    const input = screen.getByRole('textbox')
    const escapeEvent = createEvent.keyDown(input, { key: 'Escape' })
    fireEvent(input, escapeEvent)

    expect(onChange).toHaveBeenCalledWith('')
    expect(parentKeyDown).toHaveBeenCalledTimes(1)
    expect(escapeEvent.defaultPrevented).toBe(false)
  })
})
