import { describe, expect, it } from 'vitest';
import { createMockNote } from '@/utils/__tests__/test-helpers';
import { normalizeNoteSort, sortNotesForDisplay } from '@/utils/noteSort';

describe('sortNotesForDisplay', () => {
  it('keeps manual ordering within pinned and unpinned groups', () => {
    const { pinned, other } = sortNotesForDisplay([
      createMockNote({ id: 'unpinned-1', title: 'Second', pinned: false }),
      createMockNote({ id: 'pinned-1', title: 'Pinned A', pinned: true }),
      createMockNote({ id: 'unpinned-2', title: 'Third', pinned: false }),
      createMockNote({ id: 'pinned-2', title: 'Pinned B', pinned: true }),
    ], 'manual');

    expect(pinned.map(note => note.id)).toEqual(['pinned-1', 'pinned-2']);
    expect(other.map(note => note.id)).toEqual(['unpinned-1', 'unpinned-2']);
  });

  it('falls back to manual when persisted sort is no longer supported', () => {
    expect(normalizeNoteSort('title')).toBe('manual');
    expect(normalizeNoteSort('unexpected')).toBe('manual');
  });

  it('sorts by last modified descending and falls back to original order for invalid dates', () => {
    const { other } = sortNotesForDisplay([
      createMockNote({ id: 'note-1', title: 'Old', updated_at: '2024-01-01T00:00:00Z' }),
      createMockNote({ id: 'note-2', title: 'Newest', updated_at: '2024-01-03T00:00:00Z' }),
      createMockNote({ id: 'note-3', title: 'Unknown', updated_at: 'not-a-date' }),
    ], 'updated_at');

    expect(other.map(note => note.id)).toEqual(['note-2', 'note-1', 'note-3']);
  });

  it('sorts by creation date descending', () => {
    const { other } = sortNotesForDisplay([
      createMockNote({ id: 'note-1', title: 'First', created_at: '2024-01-01T00:00:00Z' }),
      createMockNote({ id: 'note-2', title: 'Third', created_at: '2024-01-03T00:00:00Z' }),
      createMockNote({ id: 'note-3', title: 'Second', created_at: '2024-01-02T00:00:00Z' }),
    ], 'created_at');

    expect(other.map(note => note.id)).toEqual(['note-2', 'note-3', 'note-1']);
  });
});
