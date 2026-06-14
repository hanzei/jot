import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import NoteContextMenu from '../src/components/NoteContextMenu';
import type { Note } from '@jot/shared';

jest.mock('../src/theme/ThemeContext', () => ({
  __esModule: true,
  useTheme: () => ({
    colors: {
      overlay: 'rgba(0,0,0,0.4)',
      sheetBackground: '#fff',
      handleColor: '#ddd',
      text: '#111',
      textSecondary: '#444',
      textMuted: '#777',
      borderLight: '#eee',
      error: '#dc2626',
    },
  }),
}));

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'note.changeColor': 'Note color',
        'note.share': 'Share',
        'note.pin': 'Pin',
        'note.unpin': 'Unpin',
        'note.archive': 'Archive',
        'note.duplicate': 'Duplicate',
        'note.moveToTrash': 'Move to trash',
        'labels.title': 'Labels',
      };
      return labels[key] ?? key;
    },
  }),
}));

let mockPendingNoteIds = new Set<string>();
jest.mock('../src/store/OfflineContext', () => ({
  __esModule: true,
  usePendingNoteIds: () => mockPendingNoteIds,
}));

afterEach(() => {
  mockPendingNoteIds = new Set<string>();
});

const baseNote: Note = {
  id: 'note-1',
  user_id: 'user-1',
  content: '',
  note_type: 'text',
  color: '#ffffff',
  pinned: false,
  archived: false,
  position: 0,
  shared_with: [],
  is_shared: false,
  labels: [],
  deleted_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

describe('NoteContextMenu labels action', () => {
  it('renders label action for synced notes when callback is provided', () => {
    const { getByTestId } = render(
      <NoteContextMenu
        visible
        note={baseNote}
        viewContext="notes"
        onClose={jest.fn()}
        onPin={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
        onDuplicate={jest.fn()}
        onMoveToTrash={jest.fn()}
        onRestore={jest.fn()}
        onDeletePermanently={jest.fn()}
        onChangeColor={jest.fn()}
        onShare={jest.fn()}
        onManageLabels={jest.fn()}
      />,
    );

    expect(getByTestId('context-label')).toBeTruthy();
  });

  it('calls onManageLabels and onClose when label action is pressed', () => {
    const onClose = jest.fn();
    const onManageLabels = jest.fn();
    const { getByTestId } = render(
      <NoteContextMenu
        visible
        note={baseNote}
        viewContext="notes"
        onClose={onClose}
        onPin={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
        onDuplicate={jest.fn()}
        onMoveToTrash={jest.fn()}
        onRestore={jest.fn()}
        onDeletePermanently={jest.fn()}
        onChangeColor={jest.fn()}
        onShare={jest.fn()}
        onManageLabels={onManageLabels}
      />,
    );

    fireEvent.press(getByTestId('context-label'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onManageLabels).toHaveBeenCalledWith(baseNote);
  });

  it('hides label action for local notes', () => {
    const { queryByTestId } = render(
      <NoteContextMenu
        visible
        note={{ ...baseNote, id: 'local_123' }}
        viewContext="notes"
        onClose={jest.fn()}
        onPin={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
        onDuplicate={jest.fn()}
        onMoveToTrash={jest.fn()}
        onRestore={jest.fn()}
        onDeletePermanently={jest.fn()}
        onChangeColor={jest.fn()}
        onShare={jest.fn()}
        onManageLabels={jest.fn()}
      />,
    );

    expect(queryByTestId('context-label')).toBeNull();
  });

  it('renders label action in my-tasks context for synced notes', () => {
    const { getByTestId } = render(
      <NoteContextMenu
        visible
        note={baseNote}
        viewContext="my-tasks"
        onClose={jest.fn()}
        onPin={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
        onDuplicate={jest.fn()}
        onMoveToTrash={jest.fn()}
        onRestore={jest.fn()}
        onDeletePermanently={jest.fn()}
        onChangeColor={jest.fn()}
        onShare={jest.fn()}
        onManageLabels={jest.fn()}
      />,
    );

    expect(getByTestId('context-label')).toBeTruthy();
  });

  it('renders label action in archived context for synced notes', () => {
    const { getByTestId } = render(
      <NoteContextMenu
        visible
        note={baseNote}
        viewContext="archived"
        onClose={jest.fn()}
        onPin={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
        onDuplicate={jest.fn()}
        onMoveToTrash={jest.fn()}
        onRestore={jest.fn()}
        onDeletePermanently={jest.fn()}
        onChangeColor={jest.fn()}
        onShare={jest.fn()}
        onManageLabels={jest.fn()}
      />,
    );

    expect(getByTestId('context-label')).toBeTruthy();
  });

  it('hides share, duplicate, and label actions for local notes', () => {
    const { queryByTestId } = render(
      <NoteContextMenu
        visible
        note={{ ...baseNote, id: 'local_123' }}
        viewContext="notes"
        onClose={jest.fn()}
        onPin={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
        onDuplicate={jest.fn()}
        onMoveToTrash={jest.fn()}
        onRestore={jest.fn()}
        onDeletePermanently={jest.fn()}
        onChangeColor={jest.fn()}
        onShare={jest.fn()}
        onManageLabels={jest.fn()}
      />,
    );

    expect(queryByTestId('context-share')).toBeNull();
    expect(queryByTestId('context-duplicate')).toBeNull();
    expect(queryByTestId('context-label')).toBeNull();
  });

  it('hides share, duplicate, and label actions for a pending-create note (#475)', () => {
    mockPendingNoteIds = new Set(['note-1']);
    const { queryByTestId } = render(
      <NoteContextMenu
        visible
        note={baseNote}
        viewContext="notes"
        onClose={jest.fn()}
        onPin={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
        onDuplicate={jest.fn()}
        onMoveToTrash={jest.fn()}
        onRestore={jest.fn()}
        onDeletePermanently={jest.fn()}
        onChangeColor={jest.fn()}
        onShare={jest.fn()}
        onManageLabels={jest.fn()}
      />,
    );

    // Non-server actions stay available; server-bound ones are gated.
    expect(queryByTestId('context-color')).toBeTruthy();
    expect(queryByTestId('context-pin')).toBeTruthy();
    expect(queryByTestId('context-share')).toBeNull();
    expect(queryByTestId('context-duplicate')).toBeNull();
    expect(queryByTestId('context-label')).toBeNull();
  });

  it('does not render label action when callback is omitted', () => {
    const { queryByTestId } = render(
      <NoteContextMenu
        visible
        note={baseNote}
        viewContext="notes"
        onClose={jest.fn()}
        onPin={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
        onDuplicate={jest.fn()}
        onMoveToTrash={jest.fn()}
        onRestore={jest.fn()}
        onDeletePermanently={jest.fn()}
        onChangeColor={jest.fn()}
        onShare={jest.fn()}
      />,
    );

    expect(queryByTestId('context-label')).toBeNull();
  });
});
