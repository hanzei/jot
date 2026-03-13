import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import NoteCard from '../src/components/NoteCard';
import { Note } from '../src/types';

const baseNote: Note = {
  id: 'note-1',
  user_id: 'user-1',
  title: 'Test Note',
  content: 'Some content here',
  note_type: 'text',
  color: '#ffffff',
  pinned: false,
  archived: false,
  position: 0,
  checked_items_collapsed: false,
  items: [],
  shared_with: [],
  is_shared: false,
  labels: [],
  deleted_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

describe('NoteCard menu button', () => {
  it('renders three-dot menu when onMenuPress is provided', () => {
    const onMenuPress = jest.fn();
    const { getByTestId } = render(
      <NoteCard note={baseNote} onPress={jest.fn()} onMenuPress={onMenuPress} />,
    );

    expect(getByTestId('note-menu-note-1')).toBeTruthy();
  });

  it('does not render menu when onMenuPress is not provided', () => {
    const { queryByTestId } = render(
      <NoteCard note={baseNote} onPress={jest.fn()} />,
    );

    expect(queryByTestId('note-menu-note-1')).toBeNull();
  });

  it('calls onMenuPress when menu button is pressed (not onPress)', () => {
    const onPress = jest.fn();
    const onMenuPress = jest.fn();
    const { getByTestId } = render(
      <NoteCard note={baseNote} onPress={onPress} onMenuPress={onMenuPress} />,
    );

    fireEvent.press(getByTestId('note-menu-note-1'));
    expect(onMenuPress).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('calls onPress when card is tapped (not the menu)', () => {
    const onPress = jest.fn();
    const onMenuPress = jest.fn();
    const { getByTestId } = render(
      <NoteCard note={baseNote} onPress={onPress} onMenuPress={onMenuPress} />,
    );

    fireEvent.press(getByTestId('note-card-note-1'));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onMenuPress).not.toHaveBeenCalled();
  });
});
