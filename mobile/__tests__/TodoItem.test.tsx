import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import TodoItem from '../src/components/TodoItem';
import type { NoteItem } from '../src/types';

const mockItem: NoteItem = {
  id: 'item-1',
  note_id: 'note-1',
  text: 'Buy groceries',
  completed: false,
  position: 0,
  indent_level: 0,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

describe('TodoItem', () => {
  it('renders the item text', () => {
    const { getByDisplayValue } = render(
      <TodoItem
        item={mockItem}
        onTextChange={jest.fn()}
        onToggle={jest.fn()}
        onDelete={jest.fn()}
      />
    );
    expect(getByDisplayValue('Buy groceries')).toBeTruthy();
  });

  it('calls onToggle when checkbox is pressed', () => {
    const onToggle = jest.fn();
    const { getByRole } = render(
      <TodoItem
        item={mockItem}
        onTextChange={jest.fn()}
        onToggle={onToggle}
        onDelete={jest.fn()}
      />
    );
    fireEvent.press(getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('calls onDelete when delete button is pressed', () => {
    const onDelete = jest.fn();
    const { getByAccessibilityLabel } = render(
      <TodoItem
        item={mockItem}
        onTextChange={jest.fn()}
        onToggle={jest.fn()}
        onDelete={onDelete}
      />
    );
    fireEvent.press(getByAccessibilityLabel('Delete item'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('calls onTextChange when text is edited', () => {
    const onTextChange = jest.fn();
    const { getByDisplayValue } = render(
      <TodoItem
        item={mockItem}
        onTextChange={onTextChange}
        onToggle={jest.fn()}
        onDelete={jest.fn()}
      />
    );
    fireEvent.changeText(getByDisplayValue('Buy groceries'), 'Buy milk');
    expect(onTextChange).toHaveBeenCalledWith('Buy milk');
  });

  it('shows completed state styling', () => {
    const completedItem = { ...mockItem, completed: true };
    const { getByRole } = render(
      <TodoItem
        item={completedItem}
        onTextChange={jest.fn()}
        onToggle={jest.fn()}
        onDelete={jest.fn()}
      />
    );
    expect(getByRole('checkbox').props.accessibilityState.checked).toBe(true);
  });
});
