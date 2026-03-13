import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockImportKeep = vi.hoisted(() => vi.fn())

vi.mock('@/utils/api', () => ({
  notes: {
    importKeep: mockImportKeep,
  },
}))

import ImportModal from '../ImportModal'

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onSuccess: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ImportModal', () => {
  describe('visibility', () => {
    it('renders the dialog when isOpen is true', () => {
      render(<ImportModal {...defaultProps} />)
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('does not render dialog content when isOpen is false', () => {
      render(<ImportModal {...defaultProps} isOpen={false} />)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('file selection', () => {
    it('shows the selected filename after choosing a file', async () => {
      const user = userEvent.setup()
      render(<ImportModal {...defaultProps} />)

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File(['{}'], 'notes.json', { type: 'application/json' })
      await user.upload(fileInput, file)

      expect(screen.getByText('notes.json')).toBeInTheDocument()
    })

    it('enables the import button after a file is selected', async () => {
      const user = userEvent.setup()
      render(<ImportModal {...defaultProps} />)

      // Import button should be disabled initially.
      expect(screen.getByRole('button', { name: /import/i })).toBeDisabled()

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      const file = new File(['{}'], 'export.json', { type: 'application/json' })
      await user.upload(fileInput, file)

      expect(screen.getByRole('button', { name: /import/i })).not.toBeDisabled()
    })
  })

  describe('successful import', () => {
    it('displays imported count after successful import', async () => {
      mockImportKeep.mockResolvedValue({ imported: 3, skipped: 0 })
      const user = userEvent.setup()
      render(<ImportModal {...defaultProps} />)

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      await user.upload(fileInput, new File(['{}'], 'notes.json', { type: 'application/json' }))
      await user.click(screen.getByRole('button', { name: /import/i }))

      await waitFor(() => {
        expect(screen.getByText(/Imported 3 notes/i)).toBeInTheDocument()
      })
    })

    it('calls onSuccess after a successful import', async () => {
      mockImportKeep.mockResolvedValue({ imported: 1, skipped: 0 })
      const onSuccess = vi.fn()
      const user = userEvent.setup()
      render(<ImportModal {...defaultProps} onSuccess={onSuccess} />)

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      await user.upload(fileInput, new File(['{}'], 'notes.json', { type: 'application/json' }))
      await user.click(screen.getByRole('button', { name: /import/i }))

      await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    })

    it('shows skipped count when notes were skipped', async () => {
      mockImportKeep.mockResolvedValue({ imported: 2, skipped: 1 })
      const user = userEvent.setup()
      render(<ImportModal {...defaultProps} />)

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      await user.upload(fileInput, new File(['{}'], 'notes.json', { type: 'application/json' }))
      await user.click(screen.getByRole('button', { name: /import/i }))

      await waitFor(() => {
        // Result text should include skipped count.
        expect(screen.getByText(/1 skipped/i)).toBeInTheDocument()
      })
    })

    it('shows error list when import returns errors array', async () => {
      mockImportKeep.mockResolvedValue({
        imported: 1,
        skipped: 0,
        errors: ['failed to import "bad note": invalid color'],
      })
      const user = userEvent.setup()
      render(<ImportModal {...defaultProps} />)

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      await user.upload(fileInput, new File(['{}'], 'notes.json', { type: 'application/json' }))
      await user.click(screen.getByRole('button', { name: /import/i }))

      await waitFor(() => {
        expect(screen.getByText(/failed to import/i)).toBeInTheDocument()
      })
    })
  })

  describe('error handling', () => {
    it('shows an error message when importKeep rejects', async () => {
      mockImportKeep.mockRejectedValue({
        response: { data: 'invalid JSON file' },
      })
      const user = userEvent.setup()
      render(<ImportModal {...defaultProps} />)

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      await user.upload(fileInput, new File(['bad'], 'notes.json', { type: 'application/json' }))
      await user.click(screen.getByRole('button', { name: /import/i }))

      await waitFor(() => {
        expect(screen.getByText(/invalid JSON file/i)).toBeInTheDocument()
      })
    })

    it('shows fallback error message when response has no data', async () => {
      mockImportKeep.mockRejectedValue(new Error('network error'))
      const user = userEvent.setup()
      render(<ImportModal {...defaultProps} />)

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
      await user.upload(fileInput, new File(['{}'], 'notes.json', { type: 'application/json' }))
      await user.click(screen.getByRole('button', { name: /import/i }))

      await waitFor(() => {
        expect(screen.getByText(/Import failed/i)).toBeInTheDocument()
      })
    })
  })

  describe('close button', () => {
    it('calls onClose when the close button is clicked', async () => {
      const onClose = vi.fn()
      const user = userEvent.setup()
      render(<ImportModal {...defaultProps} onClose={onClose} />)

      const cancelBtn = screen.getByRole('button', { name: /cancel/i })
      await user.click(cancelBtn)

      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})
