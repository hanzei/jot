import React from 'react';
import { render } from '@testing-library/react-native';
import TodoItem from '../src/components/TodoItem';

describe('TodoItem drag handle', () => {
  it('renders drag handle when showDragHandle is true and onDrag provided', () => {
    const onDrag = jest.fn();
    const { getByTestId } = render(
      <TodoItem text="Task" completed={false} showDragHandle onDrag={onDrag} />,
    );

    expect(getByTestId('todo-item-drag-handle')).toBeTruthy();
  });

  it('does not render drag handle by default', () => {
    const { queryByTestId } = render(
      <TodoItem text="Task" completed={false} />,
    );

    expect(queryByTestId('todo-item-drag-handle')).toBeNull();
  });

  it('does not render drag handle when showDragHandle is true but onDrag is not provided', () => {
    const { queryByTestId } = render(
      <TodoItem text="Task" completed={false} showDragHandle />,
    );

    expect(queryByTestId('todo-item-drag-handle')).toBeNull();
  });
});
