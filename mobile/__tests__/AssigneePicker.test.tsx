import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import AssigneePicker from '../src/components/AssigneePicker';
import type { Collaborator } from '@jot/shared';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const collaborators: Collaborator[] = [
  { userId: 'u1', username: 'alice', firstName: 'Alice', lastName: 'Smith' },
  { userId: 'u2', username: 'bob', firstName: 'Bob' },
];

describe('AssigneePicker', () => {
  it('renders collaborator options when visible', () => {
    const { getByText } = render(
      <AssigneePicker
        visible={true}
        collaborators={collaborators}
        currentAssigneeId=""
        onAssign={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(getByText('Alice Smith')).toBeTruthy();
    expect(getByText('Bob')).toBeTruthy();
    expect(getByText('Assign item')).toBeTruthy();
  });

  it('calls onAssign with userId when a collaborator is pressed', () => {
    const onAssign = jest.fn();
    const onClose = jest.fn();
    const { getByTestId } = render(
      <AssigneePicker
        visible={true}
        collaborators={collaborators}
        currentAssigneeId=""
        onAssign={onAssign}
        onClose={onClose}
      />,
    );

    fireEvent.press(getByTestId('assignee-option-u1'));
    expect(onAssign).toHaveBeenCalledWith('u1');
    expect(onClose).toHaveBeenCalled();
  });

  it('toggles off (unassigns) when pressing the already-selected collaborator', () => {
    const onAssign = jest.fn();
    const { getByTestId } = render(
      <AssigneePicker
        visible={true}
        collaborators={collaborators}
        currentAssigneeId="u1"
        onAssign={onAssign}
        onClose={jest.fn()}
      />,
    );

    fireEvent.press(getByTestId('assignee-option-u1'));
    expect(onAssign).toHaveBeenCalledWith('');
  });

  it('shows unassign button when there is a current assignee', () => {
    const onAssign = jest.fn();
    const onClose = jest.fn();
    const { getByTestId, getByText } = render(
      <AssigneePicker
        visible={true}
        collaborators={collaborators}
        currentAssigneeId="u2"
        onAssign={onAssign}
        onClose={onClose}
      />,
    );

    expect(getByText('Unassign')).toBeTruthy();
    fireEvent.press(getByTestId('assignee-unassign'));
    expect(onAssign).toHaveBeenCalledWith('');
    expect(onClose).toHaveBeenCalled();
  });

  it('does not show unassign button when no current assignee', () => {
    const { queryByTestId } = render(
      <AssigneePicker
        visible={true}
        collaborators={collaborators}
        currentAssigneeId=""
        onAssign={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(queryByTestId('assignee-unassign')).toBeNull();
  });

  it('calls onClose when close button pressed', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <AssigneePicker
        visible={true}
        collaborators={collaborators}
        currentAssigneeId=""
        onAssign={jest.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.press(getByTestId('assignee-picker-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders without crashing when collaborators is empty', () => {
    const { getByText, queryByTestId } = render(
      <AssigneePicker
        visible={true}
        collaborators={[]}
        currentAssigneeId=""
        onAssign={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(getByText('Assign item')).toBeTruthy();
    expect(queryByTestId('assignee-option-u1')).toBeNull();
  });
});
