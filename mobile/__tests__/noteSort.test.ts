import type { Note } from '@jot/shared';
import { getNoteSortLabel, normalizeNoteSort, sortNotesForDisplay } from '../src/utils/noteSort';

const createMockNote = (overrides: Partial<ReturnType<typeof buildNote>> = {}) => buildNote(overrides);

function buildNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    user_id: 'user-1',
    title: 'Test Note',
    content: '',
    note_type: 'text',
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 0,
    checked_items_collapsed: false,
    is_shared: false,
    labels: [],
    shared_with: [],
    deleted_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('mobile noteSort', () => {
  it('normalizes invalid sort values to manual', () => {
    expect(normalizeNoteSort('updated_at')).toBe('updated_at');
    expect(normalizeNoteSort('unexpected')).toBe('manual');
    expect(normalizeNoteSort()).toBe('manual');
  });

  it('returns labels for sort modes', () => {
    expect(getNoteSortLabel('manual')).toBe('Manual');
    expect(getNoteSortLabel('title')).toBe('Alphabetical');
  });

  it('keeps manual ordering within pinned and unpinned groups', () => {
    const sorted = sortNotesForDisplay([
      createMockNote({ id: 'unpinned-1', title: 'Second', pinned: false }),
      createMockNote({ id: 'pinned-1', title: 'Pinned A', pinned: true }),
      createMockNote({ id: 'unpinned-2', title: 'Third', pinned: false }),
      createMockNote({ id: 'pinned-2', title: 'Pinned B', pinned: true }),
    ], 'manual');

    expect(sorted.map(note => note.id)).toEqual([
      'pinned-1',
      'pinned-2',
      'unpinned-1',
      'unpinned-2',
    ]);
  });

  it('sorts titles alphabetically without case sensitivity', () => {
    const sorted = sortNotesForDisplay([
      createMockNote({ id: 'note-1', title: 'zulu' }),
      createMockNote({ id: 'note-2', title: 'Alpha' }),
      createMockNote({ id: 'note-3', title: 'bravo' }),
    ], 'title');

    expect(sorted.map(note => note.title)).toEqual(['Alpha', 'bravo', 'zulu']);
  });

  it('sorts by last modified descending', () => {
    const sorted = sortNotesForDisplay([
      createMockNote({ id: 'note-1', title: 'Old', updated_at: '2024-01-01T00:00:00Z' }),
      createMockNote({ id: 'note-2', title: 'Newest', updated_at: '2024-01-03T00:00:00Z' }),
      createMockNote({ id: 'note-3', title: 'Middle', updated_at: '2024-01-02T00:00:00Z' }),
    ], 'updated_at');

    expect(sorted.map(note => note.id)).toEqual(['note-2', 'note-3', 'note-1']);
  });

  it('sorts by creation date descending', () => {
    const sorted = sortNotesForDisplay([
      createMockNote({ id: 'note-1', title: 'First', created_at: '2024-01-01T00:00:00Z' }),
      createMockNote({ id: 'note-2', title: 'Third', created_at: '2024-01-03T00:00:00Z' }),
      createMockNote({ id: 'note-3', title: 'Second', created_at: '2024-01-02T00:00:00Z' }),
    ], 'created_at');

    expect(sorted.map(note => note.id)).toEqual(['note-2', 'note-3', 'note-1']);
  });

  it('keeps pinned notes above unpinned notes for non-manual sorts', () => {
    const sorted = sortNotesForDisplay([
      createMockNote({ id: 'unpinned-newer', title: 'Bravo', pinned: false, created_at: '2024-01-03T00:00:00Z' }),
      createMockNote({ id: 'pinned-older', title: 'Alpha', pinned: true, created_at: '2024-01-01T00:00:00Z' }),
      createMockNote({ id: 'unpinned-older', title: 'Charlie', pinned: false, created_at: '2024-01-02T00:00:00Z' }),
      createMockNote({ id: 'pinned-newer', title: 'Zulu', pinned: true, created_at: '2024-01-04T00:00:00Z' }),
    ], 'created_at');

    expect(sorted.map(note => note.id)).toEqual([
      'pinned-newer',
      'pinned-older',
      'unpinned-newer',
      'unpinned-older',
    ]);
  });
});
