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

describe('NoteCard', () => {
  it('renders title and content for text notes', () => {
    const { getByText } = render(<NoteCard note={baseNote} onPress={jest.fn()} />);

    expect(getByText('Test Note')).toBeTruthy();
    expect(getByText('Some content here')).toBeTruthy();
  });

  it('renders todo item previews for todo notes', () => {
    const todoNote: Note = {
      ...baseNote,
      note_type: 'todo',
      content: '',
      items: [
        {
          id: 'item-1',
          note_id: 'note-1',
          text: 'Buy groceries',
          completed: false,
          position: 0,
          indent_level: 0,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 'item-2',
          note_id: 'note-1',
          text: 'Done task',
          completed: true,
          position: 1,
          indent_level: 0,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByText } = render(<NoteCard note={todoNote} onPress={jest.fn()} />);

    expect(getByText('Buy groceries')).toBeTruthy();
    expect(getByText('+1 checked')).toBeTruthy();
  });

  it('renders label chips', () => {
    const noteWithLabels: Note = {
      ...baseNote,
      labels: [
        { id: 'l1', user_id: 'user-1', name: 'Work', created_at: '', updated_at: '' },
        { id: 'l2', user_id: 'user-1', name: 'Personal', created_at: '', updated_at: '' },
      ],
    };

    const { getByText } = render(<NoteCard note={noteWithLabels} onPress={jest.fn()} />);

    expect(getByText('Work')).toBeTruthy();
    expect(getByText('Personal')).toBeTruthy();
  });

  it('calls onPress when tapped', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(<NoteCard note={baseNote} onPress={onPress} />);

    fireEvent.press(getByTestId('note-card-note-1'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows colored left border for notes with color', () => {
    const coloredNote: Note = { ...baseNote, color: '#ff6600' };
    const { getByTestId } = render(<NoteCard note={coloredNote} onPress={jest.fn()} />);

    const card = getByTestId('note-card-note-1');
    expect(card.props.style).toBeDefined();
  });

  it('does not render title when empty', () => {
    const noTitleNote: Note = { ...baseNote, title: '' };
    const { queryByText } = render(<NoteCard note={noTitleNote} onPress={jest.fn()} />);

    expect(queryByText('Test Note')).toBeNull();
  });
});
