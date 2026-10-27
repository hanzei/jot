import { describe, it, expect } from 'vitest';
import type { NoteRevision, NoteRevisionItem } from '@jot/shared';
import { compareItems, compareRevision, isUnchanged, revisionListItems } from '../revisionDiff';
import type { ListItem } from '../noteItems';

const revItem = (id: string, text: string, overrides: Partial<NoteRevisionItem> = {}): NoteRevisionItem => ({
  id, text, completed: false, position: 0, parent_id: null, assigned_to: '', ...overrides,
});

const revision = (overrides: Partial<NoteRevision>): NoteRevision => ({
  id: 'rev1',
  note_id: 'note1',
  note_type: 'text',
  title: '',
  actor_id: null,
  edited_at: '2026-10-01T10:00:00Z',
  created_at: '2026-10-01T10:05:00Z',
  content: '',
  items: [],
  ...overrides,
});

const listItem = (id: string, text: string, position: number, overrides: Partial<ListItem> = {}): ListItem => ({
  id, text, completed: false, position, parentId: null, assigned_to: '', ...overrides,
});

describe('revisionListItems', () => {
  it('maps revision items to editor items in display order', () => {
    const items = revisionListItems(revision({
      note_type: 'list',
      items: [
        revItem('b', 'child', { position: 2, parent_id: 'a' }),
        revItem('a', 'parent', { position: 0 }),
      ],
    }));
    expect(items.map(item => [item.id, item.parentId])).toEqual([['a', null], ['b', 'a']]);
  });
});

describe('compareItems', () => {
  const before = [listItem('a', 'milk', 0), listItem('b', 'eggs', 1), listItem('c', 'bread', 2)];

  it('reports added, removed, edited, and toggled items', () => {
    const after = [
      listItem('a', 'oat milk', 0),
      listItem('b', 'eggs', 1, { completed: true }),
      listItem('d', 'butter', 2),
    ];
    expect(compareItems(before, after)).toEqual([
      { kind: 'edited', before: 'milk', after: 'oat milk' },
      { kind: 'checked', text: 'eggs' },
      { kind: 'added', text: 'butter' },
      { kind: 'removed', text: 'bread' },
      { kind: 'reordered' },
    ]);
  });

  it('reports a pure reorder once', () => {
    const after = [listItem('c', 'bread', 0), listItem('a', 'milk', 1), listItem('b', 'eggs', 2)];
    expect(compareItems(before, after)).toEqual([{ kind: 'reordered' }]);
  });

  it('reports nothing for identical lists', () => {
    expect(compareItems(before, before)).toEqual([]);
  });
});

describe('compareRevision', () => {
  it('line-diffs two text versions', () => {
    const result = compareRevision(revision({ content: 'a\nb' }), { noteType: 'text', title: '', content: 'a\nc', items: [] });
    expect(result).toEqual({
      kind: 'text',
      lines: [{ kind: 'same', text: 'a' }, { kind: 'removed', text: 'b' }, { kind: 'added', text: 'c' }],
    });
    expect(isUnchanged(result)).toBe(false);
  });

  it('compares lists item by item, including the title', () => {
    const result = compareRevision(
      revision({ note_type: 'list', title: 'Groceries', items: [revItem('a', 'milk')] }),
      { noteType: 'list', title: 'Shopping', content: '', items: [listItem('a', 'milk', 0)] },
    );
    expect(result).toEqual({ kind: 'list', titleBefore: 'Groceries', titleAfter: 'Shopping', changes: [] });
    expect(isUnchanged(result)).toBe(false);
  });

  it('compares across a type change as text', () => {
    const result = compareRevision(
      revision({ note_type: 'list', title: 'Groceries', items: [revItem('a', 'milk')] }),
      { noteType: 'text', title: '', content: '# Groceries\n\n- [ ] milk', items: [] },
    );
    expect(result.kind).toBe('converted');
    if (result.kind !== 'converted') return;
    expect(result.revisionType).toBe('list');
    expect(result.lines.every(line => line.kind === 'same')).toBe(true);
    // A type change is never "unchanged", even when the text renders alike.
    expect(isUnchanged(result)).toBe(false);
  });

  it('detects an unchanged version', () => {
    expect(isUnchanged(compareRevision(revision({ content: 'same' }), { noteType: 'text', title: '', content: 'same', items: [] }))).toBe(true);
  });
});
