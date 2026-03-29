import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { VALIDATION } from '@jot/shared';
import NoteCard from '../src/components/NoteCard';
import i18n from '../src/i18n';
import type { Note } from '@jot/shared';

jest.mock('../src/store/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({
    user: { id: 'current-user', username: 'testuser' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

jest.mock('../src/store/UsersContext', () => ({
  __esModule: true,
  useUsers: () => ({
    usersById: new Map(),
    refreshUsers: jest.fn(),
  }),
}));

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
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

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
          assigned_to: '',
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
          assigned_to: '',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByText } = render(<NoteCard note={todoNote} onPress={jest.fn()} />);

    expect(getByText('Buy groceries')).toBeTruthy();
    expect(getByText('+1 completed items')).toBeTruthy();
  });

  it('indents todo preview rows using indent_level', () => {
    const todoWithNestedItems: Note = {
      ...baseNote,
      note_type: 'todo',
      content: '',
      items: [
        {
          id: 'item-parent',
          note_id: 'note-1',
          text: 'Parent task',
          completed: false,
          position: 0,
          indent_level: 0,
          assigned_to: '',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 'item-child',
          note_id: 'note-1',
          text: 'Child task',
          completed: false,
          position: 1,
          indent_level: 1,
          assigned_to: '',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByTestId } = render(<NoteCard note={todoWithNestedItems} onPress={jest.fn()} />);

    const parentRow = getByTestId('note-card-todo-row-item-parent');
    const childRow = getByTestId('note-card-todo-row-item-child');

    expect(StyleSheet.flatten(parentRow.props.style)?.marginLeft).toBe(0);
    expect(StyleSheet.flatten(childRow.props.style)?.marginLeft).toBe(1 * VALIDATION.INDENT_PX_PER_LEVEL);
  });

  it('clamps negative todo preview indentation to zero', () => {
    const todoWithNegativeIndent: Note = {
      ...baseNote,
      note_type: 'todo',
      content: '',
      items: [
        {
          id: 'item-negative-indent',
          note_id: 'note-1',
          text: 'Task with invalid indent',
          completed: false,
          position: 0,
          indent_level: -2,
          assigned_to: '',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByTestId } = render(<NoteCard note={todoWithNegativeIndent} onPress={jest.fn()} />);
    const row = getByTestId('note-card-todo-row-item-negative-indent');

    expect(StyleSheet.flatten(row.props.style)?.marginLeft).toBe(0);
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

  it('uses note color as background for colored notes', () => {
    const coloredNote: Note = { ...baseNote, color: '#fbbc04' };
    const { getByTestId } = render(<NoteCard note={coloredNote} onPress={jest.fn()} />);

    const card = getByTestId('note-card-note-1');
    expect(StyleSheet.flatten(card.props.style)?.backgroundColor).toBe('#fbbc04');
  });

  it('uses default white background for notes without color', () => {
    const { getByTestId } = render(<NoteCard note={baseNote} onPress={jest.fn()} />);

    const card = getByTestId('note-card-note-1');
    expect(StyleSheet.flatten(card.props.style)?.backgroundColor).toBe('#fff');
  });

  it('does not render title when empty', () => {
    const noTitleNote: Note = { ...baseNote, title: '' };
    const { queryByText } = render(<NoteCard note={noTitleNote} onPress={jest.fn()} />);

    expect(queryByText('Test Note')).toBeNull();
  });

  it('does not show assignee avatar for assigned todo items', () => {
    const sharedTodo: Note = {
      ...baseNote,
      note_type: 'todo',
      content: '',
      is_shared: true,
      items: [
        {
          id: 'item-1',
          note_id: 'note-1',
          text: 'Assigned task',
          completed: false,
          position: 0,
          indent_level: 0,
          assigned_to: 'user-2',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByText, queryByText } = render(
      <NoteCard note={sharedTodo} onPress={jest.fn()} />,
    );

    expect(getByText('Assigned task')).toBeTruthy();
    // Assignee avatar letter 'B' (for user-2) should not appear in the preview
    expect(queryByText('B')).toBeNull();
  });

  it('renders owner avatar for shared-with-you notes', () => {
    const sharedNote: Note = {
      ...baseNote,
      user_id: 'owner-1',
      is_shared: true,
      shared_with: [
        {
          id: 'share-1',
          note_id: 'note-1',
          shared_with_user_id: 'current-user',
          shared_by_user_id: 'owner-1',
          permission_level: 'edit',
          username: 'testuser',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByText } = render(
      <NoteCard note={sharedNote} onPress={jest.fn()} />,
    );

    // Owner avatar letter '?' shown (owner not in usersById mock)
    expect(getByText('?')).toBeTruthy();
  });

  it('renders avatars for notes shared by the owner', () => {
    const ownedSharedNote: Note = {
      ...baseNote,
      user_id: 'current-user',
      shared_with: [
        {
          id: 'share-1',
          note_id: 'note-1',
          shared_with_user_id: 'user-2',
          shared_by_user_id: 'current-user',
          permission_level: 'edit',
          username: 'bob',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const { getByText } = render(
      <NoteCard note={ownedSharedNote} onPress={jest.fn()} />,
    );

    expect(getByText('B')).toBeTruthy();
  });
});
