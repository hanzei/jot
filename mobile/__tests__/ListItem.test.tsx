import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Animated, StyleSheet } from 'react-native';
import { VALIDATION } from '@jot/shared';
import ListItem from '../src/components/ListItem';
import * as layoutAnimation from '../src/utils/layoutAnimation';
import type { Collaborator } from '@jot/shared';

const collaborators: Collaborator[] = [
  { userId: 'u1', username: 'alice', firstName: 'Alice' },
  { userId: 'u2', username: 'bob', firstName: 'Bob' },
];

describe('ListItem', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders text and unchecked checkbox', () => {
    const { getByTestId } = render(
      <ListItem text="Buy milk" completed={false} />,
    );

    expect(getByTestId('list-item-text').props.value).toBe('Buy milk');
  });

  it('calls onToggle when checkbox pressed', () => {
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <ListItem text="Task" completed={false} onToggle={onToggle} />,
    );

    fireEvent.press(getByTestId('list-item-checkbox'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('calls onChangeText when text changed', () => {
    const onChangeText = jest.fn();
    const { getByTestId } = render(
      <ListItem text="Task" completed={false} onChangeText={onChangeText} />,
    );

    fireEvent.changeText(getByTestId('list-item-text'), 'Updated task');
    expect(onChangeText).toHaveBeenCalledWith('Updated task');
  });

  it('calls onDelete when delete button pressed', () => {
    const onDelete = jest.fn();
    const { getByTestId } = render(
      <ListItem text="Task" completed={false} onDelete={onDelete} />,
    );

    // The delete button only appears while the row is focused (selected).
    fireEvent(getByTestId('list-item-text'), 'focus');
    fireEvent.press(getByTestId('list-item-delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('hides the delete button until the row is focused', () => {
    const { getByTestId, queryByTestId } = render(
      <ListItem text="Task" completed={false} onDelete={jest.fn()} />,
    );

    expect(queryByTestId('list-item-delete')).toBeNull();
    fireEvent(getByTestId('list-item-text'), 'focus');
    expect(queryByTestId('list-item-delete')).not.toBeNull();
  });

  it('does not show delete button when not editable', () => {
    const { queryByTestId } = render(
      <ListItem text="Task" completed={false} editable={false} onDelete={jest.fn()} />,
    );

    expect(queryByTestId('list-item-delete')).toBeNull();
  });

  it('applies strikethrough style to completed items', () => {
    const { getByTestId } = render(
      <ListItem text="Done task" completed={true} />,
    );

    const textInput = getByTestId('list-item-text');
    const flatStyle = Array.isArray(textInput.props.style)
      ? Object.assign({}, ...textInput.props.style)
      : textInput.props.style;
    expect(flatStyle.textDecorationLine).toBe('line-through');
  });

  it('uses shared indent spacing for positive indent levels', () => {
    const { getByTestId } = render(
      <ListItem text="Indented task" completed={false} indentLevel={1} />,
    );

    const row = getByTestId('list-item-row');
    expect(StyleSheet.flatten(row.props.style)?.marginLeft).toBe(VALIDATION.INDENT_PX_PER_LEVEL);
  });

  it('clamps negative indent levels to zero', () => {
    const { getByTestId } = render(
      <ListItem text="Invalid indent task" completed={false} indentLevel={-2} />,
    );

    const row = getByTestId('list-item-row');
    expect(StyleSheet.flatten(row.props.style)?.marginLeft).toBe(0);
  });

  it('uses multiline text input for wrapping long text', () => {
    const { getByTestId } = render(
      <ListItem text="A very long task text that should wrap to the next line" completed={false} />,
    );

    expect(getByTestId('list-item-text').props.multiline).toBe(true);
  });

  it('shows assign button when shared with collaborators', () => {
    const onAssignPress = jest.fn();
    const { getByTestId } = render(
      <ListItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={collaborators}
        onAssignPress={onAssignPress}
      />,
    );

    expect(getByTestId('list-item-assign')).toBeTruthy();
    fireEvent.press(getByTestId('list-item-assign'));
    expect(onAssignPress).toHaveBeenCalledTimes(1);
  });

  it('hides assign button when not shared', () => {
    const { queryByTestId } = render(
      <ListItem
        text="Task"
        completed={false}
        isShared={false}
        collaborators={collaborators}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('list-item-assign')).toBeNull();
  });

  it('hides assign button when no collaborators', () => {
    const { queryByTestId } = render(
      <ListItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={[]}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('list-item-assign')).toBeNull();
  });

  it('shows assignee avatar when item is assigned', () => {
    const { getByTestId } = render(
      <ListItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={collaborators}
        assignedTo="u1"
        onAssignPress={jest.fn()}
      />,
    );

    expect(getByTestId('list-item-assignee')).toBeTruthy();
  });

  it('hides unassigned placeholder for completed items', () => {
    const { queryByTestId } = render(
      <ListItem
        text="Task"
        completed={true}
        isShared={true}
        collaborators={collaborators}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('list-item-assign')).toBeNull();
  });

  it('shows assignee avatar for completed items (read-only)', () => {
    const { getByTestId } = render(
      <ListItem
        text="Task"
        completed={true}
        isShared={true}
        collaborators={collaborators}
        assignedTo="u1"
        onAssignPress={jest.fn()}
      />,
    );

    expect(getByTestId('list-item-assignee')).toBeTruthy();
  });

  describe('checkbox pop animation', () => {
    it('pops the checkbox on mount when popOnMount is set', () => {
      jest.spyOn(layoutAnimation, 'isReduceMotionEnabledSync').mockReturnValue(false);
      const springSpy = jest.spyOn(Animated, 'spring');

      render(<ListItem text="Done" completed={true} popOnMount />);

      expect(springSpy).toHaveBeenCalledTimes(1);
      expect(springSpy.mock.calls[0][1]).toMatchObject({ toValue: 1 });
    });

    it('does not pop when popOnMount is not set', () => {
      jest.spyOn(layoutAnimation, 'isReduceMotionEnabledSync').mockReturnValue(false);
      const springSpy = jest.spyOn(Animated, 'spring');

      render(<ListItem text="Done" completed={true} />);

      expect(springSpy).not.toHaveBeenCalled();
    });

    it('does not pop when Reduce Motion is enabled', () => {
      jest.spyOn(layoutAnimation, 'isReduceMotionEnabledSync').mockReturnValue(true);
      const springSpy = jest.spyOn(Animated, 'spring');

      render(<ListItem text="Done" completed={true} popOnMount />);

      expect(springSpy).not.toHaveBeenCalled();
    });
  });
});
