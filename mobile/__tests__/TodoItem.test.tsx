import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import TodoItem from '../src/components/TodoItem';

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
});
