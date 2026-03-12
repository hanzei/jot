import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import NoteCard from '../src/components/NoteCard';
import type { Note } from '../src/types';

const mockNote: Note = {
  id: 'test-id',
  user_id: 'user-1',
  title: 'Test Note',
  content: 'Test content',
  note_type: 'text',
  color: '#ffffff',
  pinned: false,
  archived: false,
  position: 0,
  checked_items_collapsed: false,
  is_shared: false,
  labels: [],
  deleted_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

describe('NoteCard', () => {
  it('renders the note title', () => {
    const { getByText } = render(
      <NoteCard note={mockNote} onPress={jest.fn()} onLongPress={jest.fn()} />
    );
    expect(getByText('Test Note')).toBeTruthy();
  });

  it('renders content preview for text notes', () => {
    const { getByText } = render(
      <NoteCard note={mockNote} onPress={jest.fn()} onLongPress={jest.fn()} />
    );
    expect(getByText('Test content')).toBeTruthy();
  });

  it('calls onPress when tapped', () => {
    const onPress = jest.fn();
    const { getByAccessibilityLabel } = render(
      <NoteCard note={mockNote} onPress={onPress} onLongPress={jest.fn()} />
    );
    fireEvent.press(getByAccessibilityLabel('Test Note'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders todo item previews for todo notes', () => {
    const todoNote: Note = {
      ...mockNote,
      note_type: 'todo',
      content: '',
      items: [
        {
          id: 'item-1',
          note_id: 'test-id',
          text: 'Buy milk',
          completed: false,
          position: 0,
          indent_level: 0,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };
    const { getByText } = render(
      <NoteCard note={todoNote} onPress={jest.fn()} onLongPress={jest.fn()} />
    );
    expect(getByText('○ Buy milk')).toBeTruthy();
  });

  it('renders label chips', () => {
    const noteWithLabels: Note = {
      ...mockNote,
      labels: [
        {
          id: 'label-1',
          user_id: 'user-1',
          name: 'Work',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };
    const { getByText } = render(
      <NoteCard note={noteWithLabels} onPress={jest.fn()} onLongPress={jest.fn()} />
    );
    expect(getByText('Work')).toBeTruthy();
  });

  it('applies background color from note', () => {
    const colorNote: Note = { ...mockNote, color: '#f28b82' };
    const { getByAccessibilityLabel } = render(
      <NoteCard note={colorNote} onPress={jest.fn()} onLongPress={jest.fn()} />
    );
    const card = getByAccessibilityLabel('Test Note');
    expect(card.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: '#f28b82' })])
    );
  });
});
