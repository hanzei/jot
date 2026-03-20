import type { Note } from '@jot/shared';
import { compareDescendingTimestamps, getNoteSortLabel, getTitleKey, normalizeNoteSort, sortNotesForDisplay } from '../src/utils/noteSort';

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
      buildNote({ id: 'unpinned-1', title: 'Second', pinned: false }),
      buildNote({ id: 'pinned-1', title: 'Pinned A', pinned: true }),
      buildNote({ id: 'unpinned-2', title: 'Third', pinned: false }),
      buildNote({ id: 'pinned-2', title: 'Pinned B', pinned: true }),
    ], 'manual');

    expect([...sorted.pinned, ...sorted.other].map(note => note.id)).toEqual([
      'pinned-1',
      'pinned-2',
      'unpinned-1',
      'unpinned-2',
    ]);
  });

  it('sorts titles alphabetically without case sensitivity', () => {
    const sorted = sortNotesForDisplay([
      buildNote({ id: 'note-1', title: 'zulu' }),
      buildNote({ id: 'note-2', title: 'Alpha' }),
      buildNote({ id: 'note-3', title: 'bravo' }),
    ], 'title');

    expect([...sorted.pinned, ...sorted.other].map(note => note.title)).toEqual(['Alpha', 'bravo', 'zulu']);
  });

  it('sorts by last modified descending', () => {
    const sorted = sortNotesForDisplay([
      buildNote({ id: 'note-1', title: 'Old', updated_at: '2024-01-01T00:00:00Z' }),
      buildNote({ id: 'note-2', title: 'Newest', updated_at: '2024-01-03T00:00:00Z' }),
      buildNote({ id: 'note-3', title: 'Middle', updated_at: '2024-01-02T00:00:00Z' }),
    ], 'updated_at');

    expect([...sorted.pinned, ...sorted.other].map(note => note.id)).toEqual(['note-2', 'note-3', 'note-1']);
  });

  it('sorts by creation date descending', () => {
    const sorted = sortNotesForDisplay([
      buildNote({ id: 'note-1', title: 'First', created_at: '2024-01-01T00:00:00Z' }),
      buildNote({ id: 'note-2', title: 'Third', created_at: '2024-01-03T00:00:00Z' }),
      buildNote({ id: 'note-3', title: 'Second', created_at: '2024-01-02T00:00:00Z' }),
    ], 'created_at');

    expect([...sorted.pinned, ...sorted.other].map(note => note.id)).toEqual(['note-2', 'note-3', 'note-1']);
  });

  it('keeps pinned notes above unpinned notes for non-manual sorts', () => {
    const sorted = sortNotesForDisplay([
      buildNote({ id: 'unpinned-newer', title: 'Bravo', pinned: false, created_at: '2024-01-03T00:00:00Z' }),
      buildNote({ id: 'pinned-older', title: 'Alpha', pinned: true, created_at: '2024-01-01T00:00:00Z' }),
      buildNote({ id: 'unpinned-older', title: 'Charlie', pinned: false, created_at: '2024-01-02T00:00:00Z' }),
      buildNote({ id: 'pinned-newer', title: 'Zulu', pinned: true, created_at: '2024-01-04T00:00:00Z' }),
    ], 'created_at');

    expect([...sorted.pinned, ...sorted.other].map(note => note.id)).toEqual([
      'pinned-newer',
      'pinned-older',
      'unpinned-newer',
      'unpinned-older',
    ]);
  });

  it('returns empty groups for empty note arrays', () => {
    expect(sortNotesForDisplay([], 'manual')).toEqual({ pinned: [], other: [] });
    expect(sortNotesForDisplay([], 'title')).toEqual({ pinned: [], other: [] });
    expect(sortNotesForDisplay([], 'updated_at')).toEqual({ pinned: [], other: [] });
  });

  it('sorts null and empty titles after real titles while preserving their relative order', () => {
    expect(getTitleKey(null)).toBe('');
    expect(getTitleKey('')).toBe('');

    const sorted = sortNotesForDisplay([
      buildNote({ id: 'note-null', title: null as unknown as string }),
      buildNote({ id: 'note-real-a', title: 'Alpha' }),
      buildNote({ id: 'note-empty', title: '' }),
      buildNote({ id: 'note-real-b', title: 'Beta' }),
    ], 'title');

    expect(sorted.other.map(note => note.id)).toEqual([
      'note-real-a',
      'note-real-b',
      'note-null',
      'note-empty',
    ]);
  });

  it('sorts invalid timestamps after valid timestamps', () => {
    expect(compareDescendingTimestamps('not-a-date', '2024-01-01T00:00:00Z')).toBeGreaterThan(0);
    expect(compareDescendingTimestamps('2024-01-01T00:00:00Z', 'not-a-date')).toBeLessThan(0);

    const updatedSort = sortNotesForDisplay([
      buildNote({ id: 'updated-invalid', updated_at: 'bad-date' }),
      buildNote({ id: 'updated-valid-new', updated_at: '2024-01-03T00:00:00Z' }),
      buildNote({ id: 'updated-valid-old', updated_at: '2024-01-01T00:00:00Z' }),
    ], 'updated_at');
    expect(updatedSort.other.map(note => note.id)).toEqual([
      'updated-valid-new',
      'updated-valid-old',
      'updated-invalid',
    ]);

    const createdSort = sortNotesForDisplay([
      buildNote({ id: 'created-invalid', created_at: 'bad-date' }),
      buildNote({ id: 'created-valid-new', created_at: '2024-01-03T00:00:00Z' }),
      buildNote({ id: 'created-valid-old', created_at: '2024-01-01T00:00:00Z' }),
    ], 'created_at');
    expect(createdSort.other.map(note => note.id)).toEqual([
      'created-valid-new',
      'created-valid-old',
      'created-invalid',
    ]);
  });
});
