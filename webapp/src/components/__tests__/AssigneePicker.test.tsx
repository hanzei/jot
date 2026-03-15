import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AssigneePicker from '../AssigneePicker'
import { Collaborator } from '@/utils/collaborators'

const collaborators: Collaborator[] = [
  { userId: 'user1', username: 'alice', firstName: 'Alice', lastName: 'Williams' },
  { userId: 'user2', username: 'bob', firstName: 'Bob', lastName: 'Martinez' },
  { userId: 'user3', username: 'carol', firstName: 'Carol' },
]

describe('AssigneePicker', () => {
  let onAssign: ReturnType<typeof vi.fn>
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onAssign = vi.fn()
    onClose = vi.fn()
  })

  it('renders header and all collaborators', () => {
    render(
      <AssigneePicker
        collaborators={collaborators}
        currentAssigneeId=""
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    expect(screen.getByText('Assign item')).toBeInTheDocument()
    expect(screen.getByText('Alice Williams')).toBeInTheDocument()
    expect(screen.getByText('Bob Martinez')).toBeInTheDocument()
    expect(screen.getByText('Carol')).toBeInTheDocument()
  })

  it('calls onAssign with user ID and closes when clicking a user', () => {
    render(
      <AssigneePicker
        collaborators={collaborators}
        currentAssigneeId=""
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    fireEvent.click(screen.getByText('Bob Martinez'))

    expect(onAssign).toHaveBeenCalledWith('user2')
    expect(onClose).toHaveBeenCalled()
  })

  it('highlights the currently assigned user', () => {
    render(
      <AssigneePicker
        collaborators={collaborators}
        currentAssigneeId="user2"
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    const bobButton = screen.getByText('Bob Martinez').closest('button')!
    expect(bobButton.className).toContain('bg-blue-50')

    const aliceButton = screen.getByText('Alice Williams').closest('button')!
    expect(aliceButton.className).not.toContain('bg-blue-50')
  })

  it('shows checkmark on the currently assigned user', () => {
    render(
      <AssigneePicker
        collaborators={collaborators}
        currentAssigneeId="user1"
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    const aliceButton = screen.getByText('Alice Williams').closest('button')!
    const checkmark = aliceButton.querySelector('svg path[d="M5 13l4 4L19 7"]')
    expect(checkmark).not.toBeNull()

    const bobButton = screen.getByText('Bob Martinez').closest('button')!
    const bobCheckmark = bobButton.querySelector('svg path[d="M5 13l4 4L19 7"]')
    expect(bobCheckmark).toBeNull()
  })

  it('clicking the assigned user toggles them off (unassigns)', () => {
    render(
      <AssigneePicker
        collaborators={collaborators}
        currentAssigneeId="user1"
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    fireEvent.click(screen.getByText('Alice Williams'))

    expect(onAssign).toHaveBeenCalledWith('')
    expect(onClose).toHaveBeenCalled()
  })

  it('shows Unassign button when someone is assigned', () => {
    render(
      <AssigneePicker
        collaborators={collaborators}
        currentAssigneeId="user2"
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    expect(screen.getByText('Unassign')).toBeInTheDocument()
  })

  it('does not show Unassign button when nobody is assigned', () => {
    render(
      <AssigneePicker
        collaborators={collaborators}
        currentAssigneeId=""
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    expect(screen.queryByText('Unassign')).not.toBeInTheDocument()
  })

  it('clicking Unassign calls onAssign with empty string', () => {
    render(
      <AssigneePicker
        collaborators={collaborators}
        currentAssigneeId="user1"
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    fireEvent.click(screen.getByText('Unassign'))

    expect(onAssign).toHaveBeenCalledWith('')
    expect(onClose).toHaveBeenCalled()
  })

  it('close button calls onClose', () => {
    render(
      <AssigneePicker
        collaborators={collaborators}
        currentAssigneeId=""
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    const closeButton = screen.getByRole('button', { name: /close/i })
    fireEvent.click(closeButton)

    expect(onClose).toHaveBeenCalled()
  })

  it('pressing Escape closes the picker', () => {
    render(
      <AssigneePicker
        collaborators={collaborators}
        currentAssigneeId=""
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
  })

  it('clicking outside the picker closes it', () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <AssigneePicker
          collaborators={collaborators}
          currentAssigneeId=""
          onAssign={onAssign}
          onClose={onClose}
        />
      </div>
    )

    fireEvent.mouseDown(screen.getByTestId('outside'))

    expect(onClose).toHaveBeenCalled()
  })

  it('clicking inside the picker does not close it', () => {
    render(
      <AssigneePicker
        collaborators={collaborators}
        currentAssigneeId=""
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    fireEvent.mouseDown(screen.getByText('Assign item'))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders with a single collaborator', () => {
    render(
      <AssigneePicker
        collaborators={[collaborators[0]]}
        currentAssigneeId=""
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    expect(screen.getByText('Alice Williams')).toBeInTheDocument()
    expect(screen.queryByText('Bob Martinez')).not.toBeInTheDocument()
  })

  it('falls back to username when no first/last name', () => {
    const usernameOnly: Collaborator[] = [
      { userId: 'u1', username: 'johndoe' },
    ]

    render(
      <AssigneePicker
        collaborators={usernameOnly}
        currentAssigneeId=""
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    expect(screen.getByText('johndoe')).toBeInTheDocument()
  })

  it('renders with empty collaborators list', () => {
    render(
      <AssigneePicker
        collaborators={[]}
        currentAssigneeId=""
        onAssign={onAssign}
        onClose={onClose}
      />
    )

    expect(screen.getByText('Assign item')).toBeInTheDocument()
    expect(screen.queryByText('Unassign')).not.toBeInTheDocument()
  })
})
