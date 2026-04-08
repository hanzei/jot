import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import ListItem from '../src/components/ListItem';

describe('ListItem drag handle', () => {
  it('renders drag handle when showDragHandle is true and onDrag provided', () => {
    const onDrag = jest.fn();
    const { getByTestId } = render(
      <ListItem text="Task" completed={false} showDragHandle onDrag={onDrag} />,
    );

    expect(getByTestId('list-item-drag-handle')).toBeTruthy();
  });

  it('calls onDrag on long press', () => {
    const onDrag = jest.fn();
    const { getByTestId } = render(
      <ListItem text="Task" completed={false} showDragHandle onDrag={onDrag} />,
    );

    fireEvent(getByTestId('list-item-drag-handle'), 'onLongPress');
    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  it('does not render drag handle by default', () => {
    const { queryByTestId } = render(
      <ListItem text="Task" completed={false} />,
    );

    expect(queryByTestId('list-item-drag-handle')).toBeNull();
  });

  it('does not render drag handle when showDragHandle is true but onDrag is not provided', () => {
    const { queryByTestId } = render(
      <ListItem text="Task" completed={false} showDragHandle />,
    );

    expect(queryByTestId('list-item-drag-handle')).toBeNull();
  });
});
