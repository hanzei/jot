import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import TodoItem from '../src/components/TodoItem';
import type { Collaborator } from '@jot/shared';

const collaborators: Collaborator[] = [
  { userId: 'u1', username: 'alice', firstName: 'Alice' },
  { userId: 'u2', username: 'bob', firstName: 'Bob' },
];

describe('TodoItem', () => {
  it('renders text and unchecked checkbox', () => {
    const { getByTestId } = render(
      <TodoItem text="Buy milk" completed={false} />,
    );

    expect(getByTestId('todo-item-text').props.value).toBe('Buy milk');
  });

  it('calls onToggle when checkbox pressed', () => {
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <TodoItem text="Task" completed={false} onToggle={onToggle} />,
    );

    fireEvent.press(getByTestId('todo-item-checkbox'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('calls onChangeText when text changed', () => {
    const onChangeText = jest.fn();
    const { getByTestId } = render(
      <TodoItem text="Task" completed={false} onChangeText={onChangeText} />,
    );

    fireEvent.changeText(getByTestId('todo-item-text'), 'Updated task');
    expect(onChangeText).toHaveBeenCalledWith('Updated task');
  });

  it('calls onDelete when delete button pressed', () => {
    const onDelete = jest.fn();
    const { getByTestId } = render(
      <TodoItem text="Task" completed={false} onDelete={onDelete} />,
    );

    fireEvent.press(getByTestId('todo-item-delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('does not show delete button when not editable', () => {
    const { queryByTestId } = render(
      <TodoItem text="Task" completed={false} editable={false} onDelete={jest.fn()} />,
    );

    expect(queryByTestId('todo-item-delete')).toBeNull();
  });

  it('applies strikethrough style to completed items', () => {
    const { getByTestId } = render(
      <TodoItem text="Done task" completed={true} />,
    );

    const textInput = getByTestId('todo-item-text');
    const flatStyle = Array.isArray(textInput.props.style)
      ? Object.assign({}, ...textInput.props.style)
      : textInput.props.style;
    expect(flatStyle.textDecorationLine).toBe('line-through');
  });

  it('shows assign button when shared with collaborators', () => {
    const onAssignPress = jest.fn();
    const { getByTestId } = render(
      <TodoItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={collaborators}
        onAssignPress={onAssignPress}
      />,
    );

    expect(getByTestId('todo-item-assign')).toBeTruthy();
    fireEvent.press(getByTestId('todo-item-assign'));
    expect(onAssignPress).toHaveBeenCalledTimes(1);
  });

  it('hides assign button when not shared', () => {
    const { queryByTestId } = render(
      <TodoItem
        text="Task"
        completed={false}
        isShared={false}
        collaborators={collaborators}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('todo-item-assign')).toBeNull();
  });

  it('hides assign button when no collaborators', () => {
    const { queryByTestId } = render(
      <TodoItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={[]}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('todo-item-assign')).toBeNull();
  });

  it('shows assignee avatar when item is assigned', () => {
    const { getByTestId } = render(
      <TodoItem
        text="Task"
        completed={false}
        isShared={true}
        collaborators={collaborators}
        assignedTo="u1"
        onAssignPress={jest.fn()}
      />,
    );

    expect(getByTestId('todo-item-assignee')).toBeTruthy();
  });

  it('hides unassigned placeholder for completed items', () => {
    const { queryByTestId } = render(
      <TodoItem
        text="Task"
        completed={true}
        isShared={true}
        collaborators={collaborators}
        onAssignPress={jest.fn()}
      />,
    );

    expect(queryByTestId('todo-item-assign')).toBeNull();
  });

  it('shows assignee avatar for completed items (read-only)', () => {
    const { getByTestId } = render(
      <TodoItem
        text="Task"
        completed={true}
        isShared={true}
        collaborators={collaborators}
        assignedTo="u1"
        onAssignPress={jest.fn()}
      />,
    );

    expect(getByTestId('todo-item-assignee')).toBeTruthy();
  });
});
