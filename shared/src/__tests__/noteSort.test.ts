import { describe, expect, it } from 'vitest';
import type { TextNote } from '../types';
import { compareDescendingTimestamps, normalizeNoteSort, sortNotesForDisplay } from '../noteSort';

function buildNote(overrides: Partial<TextNote> & { id: string }): TextNote {
  return {
    user_id: 'user-1',
    content: '',
    note_type: 'text',
    version: 1,
    color: '#ffffff',
    pinned: false,
    archived: false,
    position: 0,
    is_shared: false,
    labels: [],
    shared_with: [],
    deleted_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('normalizeNoteSort', () => {
  it('accepts supported sort values', () => {
    expect(normalizeNoteSort('updated_at')).toBe('updated_at');
    expect(normalizeNoteSort('created_at')).toBe('created_at');
    expect(normalizeNoteSort('manual')).toBe('manual');
  });

  it('falls back to manual for unsupported or missing values', () => {
    expect(normalizeNoteSort('unsupported')).toBe('manual');
    expect(normalizeNoteSort()).toBe('manual');
  });
});

describe('compareDescendingTimestamps', () => {
  it('sorts invalid timestamps after valid timestamps', () => {
    expect(compareDescendingTimestamps('not-a-date', '2024-01-01T00:00:00Z')).toBeGreaterThan(0);
    expect(compareDescendingTimestamps('2024-01-01T00:00:00Z', 'not-a-date')).toBeLessThan(0);
    expect(compareDescendingTimestamps('not-a-date', 'also-not-a-date')).toBe(0);
  });
});

describe('sortNotesForDisplay', () => {
  it('keeps manual ordering within pinned and unpinned groups', () => {
    const { pinned, other } = sortNotesForDisplay([
      buildNote({ id: 'unpinned-1', pinned: false }),
      buildNote({ id: 'pinned-1', pinned: true }),
      buildNote({ id: 'unpinned-2', pinned: false }),
      buildNote({ id: 'pinned-2', pinned: true }),
    ], 'manual');

    expect(pinned.map(note => note.id)).toEqual(['pinned-1', 'pinned-2']);
    expect(other.map(note => note.id)).toEqual(['unpinned-1', 'unpinned-2']);
  });

  it('sorts by last modified descending and falls back to original order for invalid dates', () => {
    const { other } = sortNotesForDisplay([
      buildNote({ id: 'note-1', updated_at: '2024-01-01T00:00:00Z' }),
      buildNote({ id: 'note-2', updated_at: '2024-01-03T00:00:00Z' }),
      buildNote({ id: 'note-3', updated_at: 'not-a-date' }),
    ], 'updated_at');

    expect(other.map(note => note.id)).toEqual(['note-2', 'note-1', 'note-3']);
  });

  it('sorts by creation date descending', () => {
    const { other } = sortNotesForDisplay([
      buildNote({ id: 'note-1', created_at: '2024-01-01T00:00:00Z' }),
      buildNote({ id: 'note-2', created_at: '2024-01-03T00:00:00Z' }),
      buildNote({ id: 'note-3', created_at: '2024-01-02T00:00:00Z' }),
    ], 'created_at');

    expect(other.map(note => note.id)).toEqual(['note-2', 'note-3', 'note-1']);
  });

  it('keeps pinned notes above unpinned notes for non-manual sorts', () => {
    const { pinned, other } = sortNotesForDisplay([
      buildNote({ id: 'unpinned-newer', pinned: false, created_at: '2024-01-03T00:00:00Z' }),
      buildNote({ id: 'pinned-older', pinned: true, created_at: '2024-01-01T00:00:00Z' }),
      buildNote({ id: 'unpinned-older', pinned: false, created_at: '2024-01-02T00:00:00Z' }),
      buildNote({ id: 'pinned-newer', pinned: true, created_at: '2024-01-04T00:00:00Z' }),
    ], 'created_at');

    expect([...pinned, ...other].map(note => note.id)).toEqual([
      'pinned-newer',
      'pinned-older',
      'unpinned-newer',
      'unpinned-older',
    ]);
  });

  it('returns empty groups for empty note arrays', () => {
    expect(sortNotesForDisplay([], 'manual')).toEqual({ pinned: [], other: [] });
    expect(sortNotesForDisplay([], 'updated_at')).toEqual({ pinned: [], other: [] });
    expect(sortNotesForDisplay([], 'created_at')).toEqual({ pinned: [], other: [] });
  });
});
